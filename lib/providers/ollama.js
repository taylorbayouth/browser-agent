'use strict';

// Ollama provider. Local /api/chat + tool calling over native fetch. No API
// key — just a reachable local server and a tool-capable model (llama3.1,
// qwen2.5, mistral-nemo, …) pulled via `ollama pull <model>`.
//
// Shares request/response shaping with openai.js via _shared.js. Ollama's two
// quirks vs OpenAI: tool-call args are objects (not JSON strings), and tool
// calls carry no id (we synthesize one for the loop's history).
//
// Prompt caching: Ollama reuses the KV cache for a byte-identical prompt prefix
// while the model stays loaded — automatic, like OpenAI's, but local and with
// no API key or usage field for it (there's no prompt_cache_key equivalent, so
// the loop's cacheKey is ignored here). The engine already puts static content
// (tools, then system) first and the dynamic turn message last, which is the
// exact byte-stable prefix Ollama needs. The catch is lifetime: Ollama unloads
// the model — and dumps its KV cache — after `keep_alive` of inactivity
// (default 5m). Per-turn requests refresh that timer, so a run stays warm; set
// OLLAMA_KEEP_ALIVE (e.g. '30m' or '-1' for forever) to also keep the cache
// across back-to-back runs.
//
// See DESIGN.md § Providers.

const {
  postJSON, buildCompletion, buildVisionResult,
  openaiStyleTool, openaiStyleMessages, parseOpenAIStyleToolCalls,
} = require('./_shared');

const DEFAULT_MODEL = 'llama3.1';
const DEFAULT_VISION_MODEL = 'llama3.2-vision';
const DEFAULT_HOST = 'http://localhost:11434';

function getBaseURL() {
  // OLLAMA_HOST is the variable the ollama CLI itself uses.
  return (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || DEFAULT_HOST).replace(/\/$/, '');
}

async function callModel(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const baseURL = getBaseURL();

  const body = {
    model,
    stream: false,
    messages: openaiStyleMessages(req.system, req.messages || [], { argsAsString: false }),
    tools: (req.tools || []).map(openaiStyleTool),
    // num_predict caps output tokens (Ollama's name for max_tokens). Unset →
    // the model's own default, matching the prior behavior.
    options: { temperature: 0, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
  };

  // Optional: keep the model (and its KV-cache prefix) loaded longer than the
  // 5m default. Passed through verbatim — Ollama accepts a duration ('30m'),
  // seconds, or a negative value for "stay loaded". Unset → server default.
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE;
  if (keepAlive) body.keep_alive = keepAlive;

  const data = await postJSON(`${baseURL}/api/chat`, {
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'Ollama API',
  });

  const message = data.message || {};
  return buildCompletion({
    provider: 'ollama',
    model,
    raw: data,
    start,
    actions: parseOpenAIStyleToolCalls(message.tool_calls, {
      argsAsString: false,
      synthId: (i) => `ollama_${Date.now()}_${i}`,
    }),
    // Ollama puts the model's prose in message.content; it has no separate
    // refusal field, so `refusal` stays null (a refusal just shows up as text).
    text: message.content || null,
    refusal: null,
    usage: {
      inputTokens: data.prompt_eval_count ?? null,
      outputTokens: data.eval_count ?? null,
    },
  });
}

// Single-shot image description. Ollama's native /api/chat takes raw base64 in
// an `images` array on the message (not OpenAI-style content parts). No tools,
// no history — see lib/vision.js for the orchestration around it.
async function describe(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_VISION_MODEL;
  const baseURL = getBaseURL();

  const data = await postJSON(`${baseURL}/api/chat`, {
    body: {
      model,
      stream: false,
      messages: [{ role: 'user', content: req.prompt, images: [req.imageBase64] }],
      options: { temperature: 0, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
    },
    signal: req.signal,
    label: 'Vision (Ollama)',
  });

  return buildVisionResult({
    provider: 'ollama',
    model,
    raw: data,
    start,
    text: (data.message?.content || '').trim(),
    usage: { inputTokens: data.prompt_eval_count ?? null, outputTokens: data.eval_count ?? null },
  });
}

const capabilities = {
  reasoningEffort: false,   // ignored today; surfaced so dispatch won't silently drop it
  vision: true,
  toolUse: 'native',        // tool-capable models only; emulation is a separate concern
  cache: 'automatic',       // local KV-cache reuse while the model stays loaded
};

/** @type {import('./types').Adapter} */
module.exports = {
  name: 'ollama',
  defaultModel: DEFAULT_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
  capabilities,
  callModel,
  describe,
};
