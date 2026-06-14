import { google } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

const BASE_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];

const cooldowns = new Map<string, number>();

let loggedFallbackState = false;
let providerCache: {
  key: string;
  baseURL: string;
  provider: ReturnType<typeof createOpenAI>;
} | null = null;

function getFallbackKey(): string {
  return (
    process.env.GROK_API ||
    process.env.GROK_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    ''
  );
}

function isGroqKey(key: string): boolean {
  return key.startsWith('gsk_');
}

function getFallbackConfig() {
  const key = getFallbackKey();
  const groq = isGroqKey(key);
  const modelName = groq ? 'llama-3.3-70b-versatile' : 'grok-2';
  const baseURL = groq
    ? 'https://api.groq.com/openai/v1'
    : 'https://api.x.ai/v1';

  if (!loggedFallbackState) {
    if (!key) {
      console.warn(
        '[Model Provider] No Grok/Groq API key detected. Set GROK_API_KEY, XAI_API_KEY or GROQ_API_KEY for fallback.',
      );
    } else {
      console.log(
        `[Model Provider] Fallback provider active: ${groq ? 'Groq' : 'xAI'} (${modelName})`,
      );
    }
    loggedFallbackState = true;
  }

  return { key, modelName, baseURL, groq };
}

function getFallbackProvider(apiKey: string, baseURL: string) {
  if (
    providerCache &&
    providerCache.key === apiKey &&
    providerCache.baseURL === baseURL
  ) {
    return providerCache.provider;
  }

  const provider = createOpenAI({ apiKey, baseURL });
  providerCache = { key: apiKey, baseURL, provider };
  return provider;
}

export function getAvailableModels(): string[] {
  const { key, modelName } = getFallbackConfig();

  const models: string[] = [];
  // Gemini models are the primary models
  models.push(...BASE_MODELS);

  if (key) {
    // Llama/Grok is the fallback model
    models.push(modelName);
  }

  const now = Date.now();
  const available = models.filter((model) => {
    const expires = cooldowns.get(model) || 0;
    return now >= expires;
  });

  if (available.length === 0) {
    console.log(
      '[Model Provider] All models are on cooldown. Resetting cooldowns.',
    );
    cooldowns.clear();
    return models;
  }

  return available;
}

export function markModelFailed(model: string, durationMs = 60000) {
  const expires = Date.now() + durationMs;
  cooldowns.set(model, expires);
  console.warn(
    `[Model Provider] Model "${model}" put on cooldown until ${new Date(expires).toLocaleTimeString()}`,
  );
}

export function clearCooldowns() {
  cooldowns.clear();
  console.log('[Model Provider] Cooldowns cleared.');
}

export function getModelInstance(modelName: string) {
  if (modelName.startsWith('gemini-')) {
    return google(modelName);
  }

  const { key, baseURL } = getFallbackConfig();
  if (key && (modelName.startsWith('llama-') || modelName === 'grok-2')) {
    return getFallbackProvider(key, baseURL).chat(modelName);
  }

  throw new Error(`[Model Provider] Unknown model name: ${modelName}`);
}

export function isFallbackModel(modelName: string): boolean {
  const { modelName: fallbackModel } = getFallbackConfig();
  return modelName === fallbackModel;
}

export function classifyRateLimitError(
  err: any,
): 'RPM' | 'TPM' | 'RPD' | 'OTHER' {
  const errMsg = String(
    err?.message ||
      err?.responseBody ||
      (err?.cause && (err.cause.message || err.cause)) ||
      err ||
      '',
  ).toLowerCase();

  if (errMsg.includes('token') || errMsg.includes('tpm')) {
    return 'TPM';
  }
  if (
    errMsg.includes('daily') ||
    errMsg.includes('rpd') ||
    errMsg.includes('perday') ||
    errMsg.includes('daily quota exceeded')
  ) {
    return 'RPD';
  }
  if (
    errMsg.includes('queries per minute') ||
    errMsg.includes('resource has been exhausted') ||
    errMsg.includes('rpm') ||
    errMsg.includes('limit: 20') ||
    errMsg.includes('rate limit') ||
    errMsg.includes('429') ||
    errMsg.includes('exhausted')
  ) {
    return 'RPM';
  }

  return 'OTHER';
}

export function logExecutionCycle(
  activeModel: string,
  status: 'SUCCESS' | 'FALLBACK_TRIGGERED',
  errorType: 'NONE' | 'RPM_LIMIT' | 'TPM_LIMIT' | 'RPD_LIMIT',
  actionTaken: 'PROCEEDED' | 'SWAPPED_MODEL' | 'SLEEP_60S',
) {
  console.log(
    JSON.stringify(
      {
        active_model: activeModel,
        status,
        error_type: errorType,
        action_taken: actionTaken,
      },
      null,
      2,
    ),
  );
}
