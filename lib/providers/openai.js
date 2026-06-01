'use strict';

// OpenAI provider. Supports two API paths:
//
//   Responses API  (/v1/responses)
//     Used when reasoningEffort is set (gpt-5 family reasoning models).
//     Required for combining function tools + reasoning_effort — Chat
//     Completions rejects that combo for these models. Wire differences:
//       - `input` instead of `messages`
//       - `reasoning: { effort }` instead of `reasoning_effort`
//       - `max_output_tokens` instead of `max_completion_tokens`
//       - flat tool shape: { type, name, description, parameters }
//       - response lives in `output[]` (function_call / message items)
//       - usage fields: input_tokens / output_tokens
//     Automatic prefix caching; prompt_cache_key/retention work here too.
//
//   Chat Completions  (/v1/chat/completions)
//     Fallback when reasoningEffort is null (older models, custom base URLs).
//     Prompt caching is automatic on OpenAI (no breakpoints): it caches the
//     longest common prefix of a request ≥1024 tokens. Two extra levers:
//       - prompt_cache_key: per-run id keeps turns sticky to one machine.
//       - prompt_cache_retention: optional via OPENAI_PROMPT_CACHE_RETENTION.
//     Cache hits surface as usage.prompt_tokens_details.cached_tokens.
//
// See DESIGN.md § Providers.

const {
  postJSON, buildCompletion, buildVisionResult, hoistRef,
  openaiStyleTool, responsesStyleTool, openaiStyleMessages, parseOpenAIStyleToolCalls,
} = require('./_shared');

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_VISION_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function promptCacheRetentionFor(model) {
  const retention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
  if (!retention) return null;

  const allow = process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS || '';
  const allowed = allow.split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return null;
  if (allowed.includes('*') || allowed.includes(model)) return retention;
  return null;
}

function addPromptCacheFields(body, req, model) {
  if (req.cacheKey) body.prompt_cache_key = String(req.cacheKey);
  const retention = promptCacheRetentionFor(model);
  if (retention) body.prompt_cache_retention = retention;
}

function getConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  return { apiKey, baseURL: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL };
}

async function callModel(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  // Route to the Responses API when reasoning effort is requested.
  // gpt-5 family models reject reasoning_effort + tools on /v1/chat/completions.
  if (req.reasoningEffort) {
    return callModelResponses(req, { start, model, apiKey, baseURL });
  }
  return callModelChatCompletions(req, { start, model, apiKey, baseURL });
}

// ─── Responses API path (/v1/responses) ──────────────────────────────────────
// Used for gpt-5 family reasoning models. Flat tool shape, `input` instead of
// `messages`, `reasoning.effort` instead of `reasoning_effort`.

async function callModelResponses(req, { start, model, apiKey, baseURL }) {
  const body = {
    model,
    max_output_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: { effort: req.reasoningEffort },
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(responsesStyleTool);
    body.tool_choice = 'required';
    // One tool call per turn — the loop executes one action per turn anyway and
    // rejects extras, so batching just wastes a call and an extra turn.
    body.parallel_tool_calls = false;
  }

  // Responses API uses `input` but accepts the same role/content message shape.
  body.input = openaiStyleMessages(req.system, req.messages || [], { argsAsString: true });

  addPromptCacheFields(body, req, model);

  const data = await postJSON(`${baseURL}/responses`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'OpenAI API',
  });

  const output = data.output || [];

  // function_call items → Actions
  const actions = output
    .filter(item => item.type === 'function_call')
    .map(fc => {
      let input = fc.arguments;
      try { input = JSON.parse(input || '{}'); } catch { input = {}; }
      const { ref, args } = hoistRef(input);
      const action = { kind: 'action', verb: fc.name, args };
      if (ref !== undefined) action.ref = ref;
      // Responses API uses call_id as the stable tool-result pairing key.
      action.toolUseId = fc.call_id || fc.id;
      return action;
    });

  // message items → prose text
  const messageItem = output.find(item => item.type === 'message');
  const text = (messageItem?.content || [])
    .filter(c => c.type === 'output_text')
    .map(c => c.text)
    .join('') || null;

  return buildCompletion({
    provider: 'openai',
    model,
    raw: data,
    start,
    actions,
    text,
    refusal: null,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      cacheReadTokens: data.usage?.input_tokens_details?.cached_tokens ?? null,
    },
  });
}

// ─── Chat Completions path (/v1/chat/completions) ─────────────────────────────
// Fallback for non-reasoning models and custom base URLs. Stable fields first
// (model, tools) before the dynamic messages array so the serialized JSON body
// has the longest cacheable prefix at the front. Two optional caching levers:
//   - prompt_cache_key: per-run id keeps turns sticky to one machine.
//   - prompt_cache_retention: optional via OPENAI_PROMPT_CACHE_RETENTION.

async function callModelChatCompletions(req, { start, model, apiKey, baseURL }) {
  const body = {
    model,
    max_completion_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  // `required` forces a tool call every turn — the only way the model can signal
  // completion is via the `done` tool, preventing prose-done loops.
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(openaiStyleTool);
    body.tool_choice = 'required';
    // One tool call per turn (see callModelResponses): matches the loop's single-action
    // execution, so the model never wastes a rejected parallel call.
    body.parallel_tool_calls = false;
  }

  body.messages = openaiStyleMessages(req.system, req.messages || [], { argsAsString: true });

  addPromptCacheFields(body, req, model);

  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'OpenAI API',
  });

  const message = data.choices?.[0]?.message || {};

  return buildCompletion({
    provider: 'openai',
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

// Single-shot image description (Chat Completions, image_url content part).
// No tools, no history — see lib/vision.js for the orchestration around it.
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
  addPromptCacheFields(body, req, model);

  const data = await postJSON(`${baseURL}/chat/completions`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'Vision (OpenAI)',
  });

  return buildVisionResult({
    provider: 'openai',
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

// Capabilities the dispatch layer reads to decide which request fields apply.
// reasoningEffort is honored only on the Responses path, but that routing is
// internal to this adapter, so from the loop's view OpenAI supports it.
const capabilities = {
  reasoningEffort: true,
  vision: true,
  toolUse: 'native',
  cache: 'automatic',
};

/** @type {import('./types').Adapter} */
module.exports = {
  name: 'openai',
  defaultModel: DEFAULT_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
  capabilities,
  callModel,
  describe,
  promptCacheRetentionFor,
};
