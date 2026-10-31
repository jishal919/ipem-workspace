const { dbRun } = require('./database');

const MODEL_RATES = {
  // OpenAI
  'gpt-4o': { input: 2.50 / 1000000, output: 10.00 / 1000000 },
  'gpt-4o-mini': { input: 0.150 / 1000000, output: 0.600 / 1000000 },
  'gpt-4-turbo': { input: 10.00 / 1000000, output: 30.00 / 1000000 },
  'gpt-4': { input: 30.00 / 1000000, output: 60.00 / 1000000 },
  'gpt-3.5-turbo': { input: 0.50 / 1000000, output: 1.50 / 1000000 },

  // Anthropic
  'claude-3-5-sonnet': { input: 3.00 / 1000000, output: 15.00 / 1000000 },
  'claude-3-7-sonnet': { input: 3.00 / 1000000, output: 15.00 / 1000000 },
  'claude-3-opus': { input: 15.00 / 1000000, output: 75.00 / 1000000 },
  'claude-3-haiku': { input: 0.25 / 1000000, output: 1.25 / 1000000 },

  // Google Gemini
  'gemini-2.5-pro': { input: 1.25 / 1000000, output: 5.00 / 1000000 },
  'gemini-2.5-flash': { input: 0.075 / 1000000, output: 0.30 / 1000000 },
  'gemini-1.5-pro': { input: 1.25 / 1000000, output: 5.00 / 1000000 },
  'gemini-1.5-flash': { input: 0.075 / 1000000, output: 0.30 / 1000000 },

  // DeepSeek
  'deepseek-r1': { input: 0.55 / 1000000, output: 2.19 / 1000000 },
  'deepseek-v3': { input: 0.27 / 1000000, output: 1.10 / 1000000 },

  // Free Providers / Self-Hosted (0 cost)
  'ollama': { input: 0, output: 0, free: true },
  'groq': { input: 0, output: 0, free: true }, // Free Tier usage
  'github': { input: 0, output: 0, free: true },
  'llama': { input: 0, output: 0, free: true },
  'qwen': { input: 0, output: 0, free: true },
  'gemma': { input: 0, output: 0, free: true },
  'mistral': { input: 0, output: 0, free: true },
  'phi': { input: 0, output: 0, free: true }
};

function isFreeProvider(provider = '', model = '') {
  const pLower = (provider || '').toLowerCase();
  const mLower = (model || '').toLowerCase();
  if (pLower.includes('ollama') || pLower.includes('groq') || pLower.includes('github') || pLower.includes('local')) {
    return true;
  }
  if (mLower.includes('ollama') || mLower.includes('groq') || mLower.includes('github')) {
    return true;
  }
  return false;
}

function estimateCost(model, inputTokens, outputTokens, provider = '') {
  if (isFreeProvider(provider, model)) {
    return 0;
  }
  const modelLower = (model || '').toLowerCase();
  let rates = null;
  for (const [key, rate] of Object.entries(MODEL_RATES)) {
    if (modelLower.includes(key)) {
      rates = rate;
      break;
    }
  }

  if (!rates || rates.free) {
    return 0;
  }

  const cost = (inputTokens * rates.input) + (outputTokens * rates.output);
  return Math.round(cost * 1000000) / 1000000;
}

async function trackLlmRequest({
  userId,
  sessionId = null,
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  promptLength = 0,
  completionLength = 0,
  promptText = null,
  completionText = null,
  latencyMs = 0,
  success = true,
  error = null,
  timestamp = null
}) {
  try {
    const totalTokens = (inputTokens || 0) + (outputTokens || 0);
    const isSuccess = success ? 1 : 0;
    const estimatedCost = estimateCost(model, inputTokens, outputTokens, provider);
    const timeVal = timestamp || new Date().toISOString().replace('T', ' ').replace('Z', '');

    await dbRun(`
      INSERT INTO llm_requests (
        user_id, session_id, provider, model, input_tokens, output_tokens, total_tokens,
        prompt_length, completion_length, prompt_text, completion_text, latency_ms,
        success, error, estimated_cost, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId || 1,
      sessionId,
      provider || 'Unknown',
      model || 'Unknown',
      inputTokens || 0,
      outputTokens || 0,
      totalTokens || 0,
      promptLength || 0,
      completionLength || 0,
      promptText ? String(promptText).slice(0, 2000) : null,
      completionText ? String(completionText).slice(0, 2000) : null,
      latencyMs || 0,
      isSuccess,
      error ? String(error).slice(0, 500) : null,
      estimatedCost,
      timeVal
    ]);

    return { success: true, estimatedCost };
  } catch (err) {
    console.error('[AI SERVICE] Failed to track LLM request:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  estimateCost,
  isFreeProvider,
  trackLlmRequest
};
