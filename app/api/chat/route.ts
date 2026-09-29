
const { embeddings, chunksCollection, VECTOR_INDEX_NAME } = await import("../../../lib/vectorStore");

export async function POST(req: Request) {
    const { message, orgId } = await req.json();

    if (!message || !orgId) {
        throw new Error("invalid parameters")
    }

    const messageVector = await embeddings.embedQuery(message)

    const pipeline = []

    pipeline.push({
        $vectorSearch: {
            index: VECTOR_INDEX_NAME,
            numCandidates: 100,
            filter: { orgId: { $eq: orgId } },
            path: "embedding",
            limit: 4,
            queryVector: messageVector
        }
    })

    pipeline.push({
        $project: { text: 1, source: 1, score: { $meta: "vectorSearchScore" } }
    })

    const likelyAnswers = await chunksCollection.aggregate(pipeline).toArray()

    const answer = likelyAnswers
        .map((chunk) => `[${chunk.score.toFixed(3)}] ${chunk.source}\n${chunk.text}`)
        .join("\n\n---\n\n");

    return Response.json({ answer });
}