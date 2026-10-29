import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error("Missing GOOGLE_API_KEY");

// Change the model in one place (or in .env) when Google releases a new one
const MODEL_NAME = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

/** What the model is used for. Each task gets its own settings. */
export type ModelTask = "chat" | "extraction";

const SETTINGS: Record<ModelTask, { temperature: number }> = {
  chat: { temperature: 0.3 },       // natural, but still factual
  extraction: { temperature: 0 },   // same documents => same policy, every time
};

export function getModel(task: ModelTask = "chat") {
  return new ChatGoogleGenerativeAI({
    model: MODEL_NAME,
    apiKey,
    temperature: SETTINGS[task].temperature,
    maxRetries: 1,
  });
}