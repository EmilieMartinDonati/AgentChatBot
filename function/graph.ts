import { getModel } from "@/lib/llm";
import {
  StateGraph,
  StateSchema,
  MessagesValue,
  GraphNode,
  START,
  END,
  Command,
  MemorySaver,
  interrupt
} from "@langchain/langgraph";
import * as z from "zod";
import { SystemMessage, AIMessage } from "@langchain/core/messages";

import { getOrder, orderSchema, updateOrderDeliveryDate } from "@/lib/orders";
import { converseWithUser } from "./conversation";

import { tool, createAgent } from "langchain";
import path from "node:path";
import fs from "node:fs/promises"

const POLICIES_DIR = path.join(process.cwd(), "policies");

const readPolicyForOrganization = tool(async (input, runtime) => {
  const orgId = input.orgId
  const filePath = path.join(POLICIES_DIR, `${orgId}.json`)
  return await fs.readFile(filePath, "utf8")
}, {
  name: "readPolicyForOrganization",
  description: "Allow to read policy regarding modification of the order delivery date for an organization",
  schema: z.object({
    orgId: z.string()
  })
})

const chatContextSchema = z.object({
  orgId: z.string()
})

const chatStateSchema = new StateSchema({
  messages: MessagesValue,                 // the whole conversation

  intent: z.enum(["conversation", "order_change"]).nullable(),

  response: z.string().nullable(),         // the text sent back to the chat

  // Everything about the order pipeline, grouped in one place.
  // null = no order change in progress. Not null = an order change is in progress,
  // so the next messages go straight back into the pipeline.
  // Needs a merge reducer (ReducedValue) so that a node can update one field
  // without erasing the others.
  orderFlow: z.object({
    // The checklist: what the customer has given so far
    orderRequest: z.object({
      orderId: z.string().nullable(),
      customerEmail: z.string().nullable(),
      shippingDate: z.string().nullable(),
      requestedDate: z.string().nullable(),  // the NEW date they want
    }),

    // Result of the last database lookup
    lookupStatus: z.enum(["not_searched", "found", "not_found"]),
    order: orderSchema.nullable(),           // the order loaded from the database, once found

    // Result of the policy check
    policyDecision: z.object({
      allowed: z.boolean(),
      reason: z.string().nullable(),         // the reason given by the policy, if refused
      feeEur: z.number().nullable(),
    }).nullable(),

    attempts: z.number(),                    // failed rounds, to avoid endless loops
  }).nullable(),
});

const orderChangeSchema = z.object({
  allowed: z.boolean().describe("Answer true if the order delivery date can be changed for the new requested date. False otherwise"),
  reason: z.string().optional().describe("Only if the change is refused: a reason that can be given to the client for why their request was refused. Leave empty if the change is allowed"),
  fee: z.number().optional().describe("If the shipping date change was accepted and there are fees that apply to the change, return the fee"),
  source: z.string().describe("The extracted JSON rows from the policy file where you found the information you needed to make their decision. Copy as such"),
})


// What the classifier fills in
const intentSchema = z.object({
  intent: z.enum(["conversation", "order_change"]),
})

// What collectOrderInfo's LLM fills in
const orderRequestSchema = z.object({
  orderId: z.string().optional(),
  customerEmail: z.string().optional(),
  shippingDate: z.string().optional(),
  requestedDate: z.string().optional(),
})

type Node = "collectOrderInfo" | "chatWithUser" | "fetchOrder" | "inquireAboutOrder" | "checkPolicy" | "handOffToHuman" | "proposeChange" | "explainRefusal" | "changeDeliveryDate"
// ============================================================================
// ROUTING AT THE START OF EACH TURN
// ============================================================================

const routeAtStart: GraphNode<typeof chatStateSchema> = async (state) => {
  // - orderFlow not null: an order change is in progress, go straight to collectOrderInfo.
  // - otherwise: go to classifyIntent.
  const orderFlow = state.orderFlow
  const nextStep = orderFlow ? "collectOrderInfo" : "classifyIntent"

  return new Command({
    goto: nextStep
  })
}

const classifyIntent: GraphNode<typeof chatStateSchema> = async (state, config) => {

  const llm = getModel()

  const structuredLlm = llm.withStructuredOutput(intentSchema)

  const classificationPrompt = `Analyze this request and classify it filling the field "intent" of your classification schema.`
  const classification = await structuredLlm.invoke([new SystemMessage(classificationPrompt), ...state.messages])

  let nextNode: Node = classification.intent === "order_change" ? "collectOrderInfo" : "chatWithUser"

  // Store classification as a single object in state
  return new Command({
    update: { intent: classification.intent },
    goto: nextNode,
  });
}

const chatWithUser: GraphNode<typeof chatStateSchema, z.infer<typeof chatContextSchema>> = async (state, config) => {

  const messages = state.messages || []

  const history = messages.map((message) => ({
    role: message.getType() === "human" ? "user" : "chat",
    text: message.text,
  }));

  const latestMessage = messages.findLast((message) => message.getType() === "human");
  if (!latestMessage) {
    throw new Error("No user message found");
  }

  const { answer } = await converseWithUser({
    history: history.slice(0, -1),
    orgId: config.context!.orgId,
    message: latestMessage.text,
  });

  // To do later: your current RAG answer.
  return { response: answer, messages: [new AIMessage(answer)] }
}


// ============================================================================
// ORDER PIPELINE
// ============================================================================

const collectOrderInfo: GraphNode<typeof chatStateSchema> = async (state, config) => {

  const llm = getModel("extraction");
  const structuredLlm = llm.withStructuredOutput(orderRequestSchema)

  const messages = state.messages;

  const instructions = `You are tasked with inferring from the user messages the relevant info about the order they want to modify in orderFlow.orderRequest.

  To this effect, you are looking for an orderId, an email or name from the costumer, a shippingDate and a requestedDate, that is the new date they want to select for their order.

  Once you have those answers, fill in the fields in state with whatever you have WITHOUT erasing previous informations.
  `
  const orderRequest = await structuredLlm.invoke([new SystemMessage(instructions), ...messages])

  const { orderId, customerEmail, shippingDate } = orderRequest;

  const previous = state.orderFlow?.orderRequest;

  // Initialize the order flow on the first turn, keep what was already there on the next ones
  const orderFlow = {
    orderRequest: {
    orderId: orderRequest.orderId ?? previous?.orderId ?? null,
    customerEmail: orderRequest.customerEmail ?? previous?.customerEmail ?? null,
    shippingDate: orderRequest.shippingDate ?? previous?.shippingDate ?? null,
    requestedDate: orderRequest.requestedDate ?? previous?.requestedDate ?? null,
  },
    lookupStatus: state.orderFlow?.lookupStatus ?? "not_searched" as const,
    order: state.orderFlow?.order ?? null,
    policyDecision: state.orderFlow?.policyDecision ?? null,
    attempts: state.orderFlow?.attempts ?? 0,
  }

  let canFetchOrder = false;
  if (orderId || (customerEmail && shippingDate)) {
    canFetchOrder = true;
  }

  let nextNode: Node = canFetchOrder ? "fetchOrder" : "inquireAboutOrder"

  // Store classification as a single object in state
  return new Command({
    update: { orderFlow },
    goto: nextNode,
  });
}

const inquireAboutOrder: GraphNode<typeof chatStateSchema> = (state, config) => {

  const currentOrderInfo = state.orderFlow?.orderRequest;
  const currentOrder = state.orderFlow?.order;
  const lookupStatus = state.orderFlow?.lookupStatus;

  let question = ""

  if (currentOrder && !currentOrderInfo?.requestedDate) {
    question = "Quelle nouvelle date de livraison souhaitez-vous?"
  }
  if (!currentOrder && lookupStatus === "not_found") {
    question = "Êtes-vous certain de nous avoir donné les bonnes informations ? Nous ne trouvons malheureusement pas votre commande ..."
  }

  if (!currentOrder && lookupStatus === "not_searched") {
    question = "Pourriez-vous nous donner plus d'informations ? :-) Avez-vous l'id de votre commande ou à défaut l'email de commande ainsi que la date de livraison initialement prévu. Vous pouvez retrouver ces informations dans votre espace-client."
  }

  return new Command({
    update: { response: question, messages: [new AIMessage(question)]  },
    goto: END
  })
}

const fetchOrder: GraphNode<typeof chatStateSchema, z.infer<typeof chatContextSchema>> = async (state, config) => {
  const context = config.context;
  if (!context) {
    throw new Error("Missing graph context");
  }
  const orgId = context.orgId;

  const orderFlow = state.orderFlow!;

  const currentOrderInfo = orderFlow.orderRequest;

  const order = await getOrder({
    orgId,
    orderId: currentOrderInfo.orderId ?? undefined,
    customerEmail: currentOrderInfo.customerEmail ?? undefined,
    shippingDate: currentOrderInfo.shippingDate ?? undefined,
  });

  const lookupStatus = order ? "found" : "not_found"
  orderFlow.lookupStatus = lookupStatus
  orderFlow.order = order
  orderFlow.attempts = orderFlow.attempts + 1

  let nextNode: Node;

  if (order && orderFlow.orderRequest!.requestedDate) {
    nextNode = "checkPolicy"
  }
  else if (!order && orderFlow.attempts > 3) {
    nextNode = "handOffToHuman"
  }
  else {
    nextNode = "inquireAboutOrder"
  }

  return new Command({
    update: { orderFlow },
    goto: nextNode,
  });
}


const checkPolicy: GraphNode<typeof chatStateSchema, z.infer<typeof chatContextSchema>> = async (state, config) => {

  const orgId = config.context!.orgId
  const orderFlow = state.orderFlow
  const order = orderFlow?.order
  const requestedDate = orderFlow?.orderRequest.requestedDate;

  if (!orgId || !orderFlow || !order || !requestedDate) {
    throw new Error("Impossible to check policy against order because either order either orgId, either requestedDate, are missing in node checkPolicy")
  }

  const SYSTEM_PROMPT = `You are tasked with looking at the policy for the organization ${orgId} to see whether the user if allowed to modify the delivery date for the new date they've chosen${requestedDate}. 
  To this effect, you need to compare the order with the delivery date change policy for this organization.
  order = ${JSON.stringify(order)}.`

  const agent = createAgent({
    model: getModel("extraction"),
    tools: [readPolicyForOrganization],
    contextSchema: z.object({
      orgId: z.string()
    }),
    systemPrompt: SYSTEM_PROMPT,
    responseFormat: orderChangeSchema
  })

  const result = await agent.invoke(
    { messages: [{ role: "user", content: "Check whether the delivery date for the order can be changed" }] },
    { context: { orgId } },
  );

  const { allowed, reason, fee } = result.structuredResponse

  let nextStep: Node = allowed ? "proposeChange" : "explainRefusal"

  return new Command({
    update: {
      orderFlow: {
        ...orderFlow, policyDecision: {
          reason: reason ?? null,
          allowed: !!allowed,
          feeEur: fee ?? null,
        }
      }
    },
    goto: nextStep
  })


}
const proposeChange: GraphNode<typeof chatStateSchema> = (state) => {
  const order = state.orderFlow?.order;
  const requestedDate = state.orderFlow?.orderRequest.requestedDate;
  const feeEur = state.orderFlow?.policyDecision?.feeEur;

  if (!order || !requestedDate) {
    throw new Error("Missing order or requested date in node proposeChange");
  }

  const formatDate = (date: Date | string) =>
    new Date(date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Paris" });

  const feeText = feeEur ? ` Ce changement vous sera facturé ${feeEur} €.` : "";
  const text = `Vous avez demandé à déplacer la livraison de votre commande ${order.orderId}, prévue le ${formatDate(order.shippingDate)}, au ${formatDate(requestedDate)}.${feeText} Confirmez-vous ce changement ?`;

  // The graph pauses here. The route returns `text` to the chat.
  // When the customer clicks Confirm / Cancel, the route resumes the graph with
  // new Command({ resume: true | false }), and that boolean is returned here.
  // Careful: on resume, this node runs again from the top, so nothing with a side effect before this line.
  const approved = interrupt<string, boolean>(text);

  if (approved !== true) {
    const text = "Bien noté, nous conservons votre date de livraison initiale."
    return new Command({
      update: {
        orderFlow: null,
        response: text,
        messages: [new AIMessage(text)]
      },
      goto: END,
    });
  }

  return new Command({ goto: "changeDeliveryDate" });
};

const changeDeliveryDate: GraphNode<typeof chatStateSchema, z.infer<typeof chatContextSchema>> = async (state, config) => {
  const order = state.orderFlow!.order;
  const requestedDate = state.orderFlow!.orderRequest!.requestedDate

  if (!order || !requestedDate) {
    throw new Error("Missing order or requested date in node changeDeliveryDate")
  }

  await updateOrderDeliveryDate({
    orgId: config.context!.orgId,
    orderId: order.orderId,
    requestedDate
  })

  const text = "La modification de votre date de livraison a été effectuée."

  return { response: text, orderFlow: null, messages: [new AIMessage(text)] }

}

const explainRefusal: GraphNode<typeof chatStateSchema> = (state) => {
  const reason = state.orderFlow!.policyDecision!.reason;

  if (!reason) {
    throw new Error("Missing reason in node explainRefusal")
  }

  return new Command({
    update: { "response": reason, messages: [new AIMessage(reason)] },
    goto: END
  })
}

const handOffToHuman: GraphNode<typeof chatStateSchema> = (state) => {
  const text = "Nous ne pouvons pas traiter votre demande faute de trouver la commande concernée. Nous vous invitons à contacter un conseiller au 06 00 00 00 00."
  return new Command({
    update: { "response": text, messages: [new AIMessage(text)] },
    goto: END
  })
}



const workflow = new StateGraph(chatStateSchema, chatContextSchema)
   .addNode("routeAtStart", routeAtStart, { ends: ["collectOrderInfo", "classifyIntent"]})
  .addNode("classifyIntent", classifyIntent, { ends: ["collectOrderInfo", "chatWithUser"] })
  .addNode("chatWithUser", chatWithUser)
  .addNode("collectOrderInfo", collectOrderInfo, { ends: ["fetchOrder", "inquireAboutOrder"] })
  .addNode("inquireAboutOrder", inquireAboutOrder)
  .addNode("fetchOrder", fetchOrder, { ends: ["checkPolicy", "handOffToHuman", "inquireAboutOrder"] })
  .addNode("checkPolicy", checkPolicy, { ends: ["proposeChange", "explainRefusal"] })
  .addNode("proposeChange", proposeChange, { ends: ["changeDeliveryDate", END] })
  .addNode("explainRefusal", explainRefusal)
  .addNode("handOffToHuman", handOffToHuman)
  .addNode("changeDeliveryDate", changeDeliveryDate)
  .addEdge(START, "routeAtStart")



// Reuse the same MemorySaver across hot reloads in dev, otherwise every save erases the conversations
const globalForGraph = globalThis as unknown as { chatMemory?: MemorySaver };

const memory = globalForGraph.chatMemory ?? new MemorySaver();
if (process.env.NODE_ENV !== "production") globalForGraph.chatMemory = memory;

export const chatApp = workflow.compile({ checkpointer: memory });