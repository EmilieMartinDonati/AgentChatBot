import { chatApp } from "@/function/graph";
import { logLastTurn } from "@/function/debug";

type HistoryMessage = { role: "user" | "chat"; text: string };

export async function POST(req: Request) {
    const { message, orgId, threadId, history } = (await req.json()) as {
        message?: string;
        orgId?: string;
        threadId?: string;
        history?: HistoryMessage[];
    };

    if (!message?.trim() || !orgId || !threadId) {
        throw new Error("Invalid parameters")
    }

    try {
        const config = { configurable: { thread_id: threadId }, context: { orgId } };
        const result = await chatApp.invoke({ messages: [{ role: "user", content: message }] }, config);

        if (process.env.NODE_ENV !== "production") await logLastTurn(chatApp, config);

        return Response.json({ answer: result.response });
    } catch (err) {
        console.error(err);
        return Response.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
    }
}