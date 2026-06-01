'use strict';

// Gemini provider. generateContent + function calling over native fetch (no SDK).
// Same paradigm as the others — POST messages + tool schemas, get back text or
// tool calls — only the wire format differs. Shares postJSON, the ref hoist, the
// JSON-schema builder, and the Completion envelope with the rest via _shared.js;
// only Gemini's distinct shape lives here:
//   - `contents` (not messages) of `parts` (not content blocks)
//   - system prompt in a top-level `systemInstruction`
//   - tools wrapped: tools[].functionDeclarations[]
//   - "must call a tool" is toolConfig.functionCallingConfig.mode:'ANY'
//   - roles are user/model (not assistant); tool results are functionResponse parts
//   - functionCall.args is already an object (like Anthropic, unlike OpenAI)
//   - auth via x-goog-api-key header; usage in usageMetadata
//
// Prompt caching: implicit caching is on by default for 2.5+ models — we just
// keep the stable prefix (systemInstruction + tools) first and read the hit count
// from usageMetadata.cachedContentTokenCount. Explicit cachedContents is a later
// concern (see docs/model-adapters-spec.md § 8).
//
// See DESIGN.md § Providers.

const { buildJsonSchema, hoistRef, postJSON, buildCompletion, buildVisionResult } = require('./_shared');

const DEFAULT_MODEL = 'gemini-3.1-pro';
const DEFAULT_VISION_MODEL = 'gemini-3.5-flash';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

function getConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const baseURL = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseURL };
}

// Gemini function declaration: { name, description, parameters } where parameters
// is an OpenAPI-subset schema — the same shape buildJsonSchema already produces.
function toGeminiTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: buildJsonSchema(tool.inputSchema),
  };
}

// Generic (Anthropic-shaped) content blocks → Gemini `contents`. Roles map
// assistant→model, user→user; tool_use becomes a functionCall part and
// tool_result becomes a functionResponse part. System messages are dropped here
// (they go in the top-level systemInstruction).
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (typeof m.content === 'string') {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }

    if (m.role === 'assistant') {
      const parts = [];
      for (const block of m.content || []) {
        if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }

    // user / tool-result-bearing turn
    const parts = [];
    for (const block of m.content || []) {
      if (block.type === 'tool_result') {
        const response = typeof block.content === 'string' ? { result: block.content } : block.content;
        parts.push({ functionResponse: { name: block.toolName || block.name || 'tool', response: response || {} } });
      } else if (block.type === 'text' && block.text) {
        parts.push({ text: block.text });
      }
    }
    if (parts.length) contents.push({ role: 'user', parts });
  }
  return contents;
}

// candidates[0].content.parts[] → Action[]. functionCall.args is already an
// object, so no JSON.parse (mirrors the Anthropic path).
function parseActions(parts) {
  const actions = [];
  for (const part of parts || []) {
    const fc = part.functionCall;
    if (!fc) continue;
    const { ref, args } = hoistRef(fc.args || {});
    const action = { kind: 'action', verb: fc.name, args };
    if (ref !== undefined) action.ref = ref;
    // Gemini doesn't return a tool-call id; pair results by function name.
    action.toolUseId = fc.name;
    actions.push(action);
  }
  return actions;
}

async function callModel(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  // Stable fields (systemInstruction, tools) first so the serialized prefix is
  // cacheable, dynamic contents last — mirrors the other providers' ordering.
  const body = {};
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

  if (req.tools && req.tools.length > 0) {
    body.tools = [{ functionDeclarations: req.tools.map(toGeminiTool) }];
    // 'ANY' forces a function call every turn — Gemini's equivalent of the other
    // providers' tool_choice:'required', so the model signals completion only via
    // the `done` tool.
    body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
  }

  body.contents = toGeminiContents(req.messages || []);
  body.generationConfig = { temperature: 0, maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS };

  const data = await postJSON(`${baseURL}/v1beta/models/${model}:generateContent`, {
    headers: { 'x-goog-api-key': apiKey },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'Gemini API',
  });

  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const proseText = parts
    .filter(p => typeof p.text === 'string')
    .map(p => p.text)
    .join('')
    .trim() || null;

  // Gemini signals a safety stop via finishReason SAFETY (no text). Surface it as
  // a refusal so callers can tell "won't" from "didn't".
  const refused = candidate?.finishReason === 'SAFETY';

  return buildCompletion({
    provider: 'gemini',
    model,
    raw: data,
    start,
    actions: parseActions(parts),
    text: proseText,
    refusal: refused ? (proseText || 'model refused (safety)') : null,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      cacheReadTokens: data.usageMetadata?.cachedContentTokenCount ?? null,
    },
  });
}

// Single-shot image description. Gemini takes the image as an inlineData part
// (base64 + mimeType) alongside the text prompt. No tools, no history — see
// lib/vision.js for the orchestration around it.
async function describe(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_VISION_MODEL;
  const { apiKey, baseURL } = getConfig();

  const data = await postJSON(`${baseURL}/v1beta/models/${model}:generateContent`, {
    headers: { 'x-goog-api-key': apiKey },
    body: {
      contents: [{
        role: 'user',
        parts: [
          { text: req.prompt },
          { inlineData: { mimeType: req.mimeType || 'image/png', data: req.imageBase64 } },
        ],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS },
    },
    signal: req.signal,
    label: 'Vision (Gemini)',
  });

  const parts = data.candidates?.[0]?.content?.parts || [];
  return buildVisionResult({
    provider: 'gemini',
    model,
    raw: data,
    start,
    text: parts.filter(p => typeof p.text === 'string').map(p => p.text).join('').trim(),
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? null,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? null,
      cacheReadTokens: data.usageMetadata?.cachedContentTokenCount ?? null,
    },
  });
}

const capabilities = {
  reasoningEffort: false,   // not wired; surfaced so dispatch won't silently drop it
  vision: true,
  toolUse: 'native',
  cache: 'implicit+explicit',
};

/** @type {import('./types').Adapter} */
module.exports = {
  name: 'gemini',
  defaultModel: DEFAULT_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
  capabilities,
  callModel,
  describe,
  // exported for unit tests / fixtures
  toGeminiContents,
  toGeminiTool,
  parseActions,
};
