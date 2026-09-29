import { ChatGoogleGenerativeAI } from "@langchain/google-genai"

const key = process.env.GOOGLE_API_KEY

export const model = new ChatGoogleGenerativeAI({
  model: "gemini-3.8-flash",
  apiKey: key,
  temperature: 0.3,
  maxRetries: 1
});

