import "server-only";

import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { db } from "./db";

// One place for these names: the seed script and the chat route must agree on them.
export const CHUNKS_COLLECTION = "chunks";
export const VECTOR_INDEX_NAME = "vector_index";

// The SAME model must be used to embed documents (seed) and questions (chat).
export const embeddings = new HuggingFaceTransformersEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2", // 384 dimensions, English only
});

export const chunksCollection = db.collection(CHUNKS_COLLECTION);

export const vectorStore = new MongoDBAtlasVectorSearch(embeddings, {
  collection: chunksCollection,
  indexName: VECTOR_INDEX_NAME,
  textKey: "text",
  embeddingKey: "embedding",
});