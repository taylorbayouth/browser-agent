'use strict';

// OpenRouter provider. OpenRouter exposes an OpenAI-compatible Chat Completions
// API at https://openrouter.ai/api/v1, giving access to hundreds of models
// (OpenAI, Anthropic, Google, Meta, Mistral, …) through a single key.
//
// Implementation is the Chat Completions path only — no Responses API, which
// is an OpenAI-specific routing detail. Prompt caching behaviour depends on the
// upstream provider OpenRouter selects; from our side it looks automatic.
//
// Optional headers HTTP-Referer / X-Title are forwarded when the corresponding
// env vars are set; they affect rankings on openrouter.ai and are otherwise no-ops.
//
// See https://openrouter.ai/docs/quickstart for the full API reference.

const {
  postJSON, buildCompletion, buildVisionResult,
  openaiStyleTool, openaiStyleMessages, parseOpenAIStyleToolCalls,
} = require('./_shared');

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_VISION_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function getConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
  return { apiKey, baseURL: process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL };
}

function extraHeaders() {
  const h = {};
  if (process.env.OPENROUTER_REFERER) h['HTTP-Referer'] = process.env.OPENROUTER_REFERER;
  if (process.env.OPENROUTER_TITLE) h['X-Title'] = process.env.OPENROUTER_TITLE;
  return h;
}

async function callModel(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  const body = {
    model,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(openaiStyleTool);
    body.tool_choice = 'required';
    body.parallel_tool_calls = false;
  }

  body.messages = openaiStyleMessages(req.system, req.messages || [], { argsAsString: true });

  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders() },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'OpenRouter API',
  });

  const message = data.choices?.[0]?.message || {};

  return buildCompletion({
    provider: 'openrouter',
    model,
    raw: data,
    start,
    actions: message.tool_calls
      ? parseOpenAIStyleToolCalls(message.tool_calls, { argsAsString: true, synthId: null })
      : [],
    text: message.content || null,
    refusal: message.refusal || null,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
  });
}

async function describe(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_VISION_MODEL;
  const { apiKey, baseURL } = getConfig();
  const dataUrl = `data:${req.mimeType || 'image/png'};base64,${req.imageBase64}`;

  const body = {
    model,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: req.prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
  };

  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders() },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'Vision (OpenRouter)',
  });

  return buildVisionResult({
    provider: 'openrouter',
    model,
    raw: data,
    start,
    text: (data.choices?.[0]?.message?.content || '').trim(),
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
      cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
  });
}

const capabilities = {
  reasoningEffort: false,
  vision: true,
  toolUse: 'native',
  cache: 'automatic',
};

/** @type {import('./types').Adapter} */
module.exports = {
  name: 'openrouter',
  defaultModel: DEFAULT_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
  capabilities,
  callModel,
  describe,
};
