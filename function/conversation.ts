import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { embeddings, chunksCollection, VECTOR_INDEX_NAME } from "@/lib/vectorStore";
import { getModel } from "@/lib/llm";

const MIN_SCORE = 0.5;

type Chunk = { text: string; source: string; orgName: string; score: number };

export const converseWithUser = async ({
    history,
    message,
    orgId
}: {
    history: Array<{ role: string, text: string }>,
    message: string,
    orgId: string
}) => {
    try {
        // Retrieval: add the previous user question so follow-ups ("and for Belgium?") keep their topic
        const previousQuestion = history.findLast((m) => m.role === "user")?.text ?? "";
        const searchText = `${previousQuestion}\n${message}`.trim();

        const queryVector = await embeddings.embedQuery(searchText);

        const results = await chunksCollection
            .aggregate<Chunk>([
                {
                    $vectorSearch: {
                        index: VECTOR_INDEX_NAME,
                        path: "embedding",
                        queryVector,
                        numCandidates: 100,
                        limit: 10,
                        filter: { orgId: { $eq: orgId } },
                    },
                },
                { $project: { _id: 0, text: 1, source: 1, orgName: 1, score: { $meta: "vectorSearchScore" } } },
            ])
            .toArray();

        const chunks = results.filter((c) => c.score >= MIN_SCORE);

        if (chunks.length === 0) {
            return {
                answer: "Désolé, je n'ai pas pu trouver cette réponse dans notre documentation.",
                sources: [],
            };
        }

        const context = chunks.map((c) => `[Source: ${c.source}]\n${c.text}`).join("\n\n---\n\n");
        const orgName = chunks[0].orgName;

        // Past messages, converted to LangChain's roles
        const historyMessages = history.map((m) =>
            m.role === "user" ? new HumanMessage(m.text) : new AIMessage(m.text),
        );

        const model = getModel("chat")

        const response = await model.invoke([
            new SystemMessage(`You are a customer support assistant for ${orgName}.
Answer the question using ONLY the context provided with the latest question.
Use the previous messages only to understand what the customer is referring to.
If the context does not contain the answer, say you don't have this information. Never invent policies, prices or dates.
Be concise and friendly. Answer in the same language as the question.`),
            ...historyMessages,
            new HumanMessage(`Context:\n${context}\n\nQuestion: ${message}`),
        ]);

        return {
            answer: response.text,
            sources: [...new Set(chunks.map((c) => c.source))],
        };
    } catch (err) {
        return {
            answer: "Une erreur s'est produite. Veuillez réessayer.",
            sources: []
        }
    }
}