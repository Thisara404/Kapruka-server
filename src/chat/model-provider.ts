import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";

const BASE_MODELS = [
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite",
];

const grokApiKey = process.env.GROK_API || process.env.GROK_API_KEY || "";
const isGroq = grokApiKey.startsWith("gsk_");

export const FALLBACK_MODEL_NAME = isGroq ? "llama-3.3-70b-versatile" : "grok-2";
const baseURL = isGroq ? "https://api.groq.com/openai/v1" : "https://api.x.ai/v1";

const fallbackProvider = createOpenAI({
  apiKey: grokApiKey,
  baseURL,
});

const cooldowns = new Map<string, number>();

export function getAvailableModels(): string[] {
  const models = [...BASE_MODELS];
  if (grokApiKey) {
    models.push(FALLBACK_MODEL_NAME);
  }

  const now = Date.now();
  const available = models.filter((model) => {
    const expires = cooldowns.get(model) || 0;
    return now >= expires;
  });

  if (available.length === 0) {
    console.log("[Model Provider] All models are on cooldown. Resetting cooldowns.");
    cooldowns.clear();
    return models;
  }

  return available;
}

export function markModelFailed(model: string, durationMs = 60000) {
  const expires = Date.now() + durationMs;
  cooldowns.set(model, expires);
  console.warn(`[Model Provider] Model "${model}" put on cooldown until ${new Date(expires).toLocaleTimeString()}`);
}

export function clearCooldowns() {
  cooldowns.clear();
  console.log("[Model Provider] Cooldowns cleared.");
}

export function getModelInstance(modelName: string) {
  if (modelName.startsWith("gemini-")) {
    return google(modelName);
  }
  if (modelName === FALLBACK_MODEL_NAME) {
    return fallbackProvider(modelName);
  }
  throw new Error(`[Model Provider] Unknown model name: ${modelName}`);
}
