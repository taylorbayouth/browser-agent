'use strict';

// Anthropic provider. Messages API + tool use over native fetch (no SDK).
// Shares the schema builder, ref hoist, postJSON, and Completion envelope with
// the other providers via _shared.js; only Anthropic's distinct wire format
// (system as a top-level field, `input_schema` tool key, `content` blocks)
// lives here.
//
// Prompt caching: the system prompt and tool definitions are byte-identical on
// every turn of a run (only the user message changes), yet a run is 30–50 turns.
// Anthropic's cache hierarchy is tools → system → messages, and a change at any
// level invalidates that level and everything after it. We set TWO breakpoints:
//   1. the last tool definition — caches the tools-only prefix on its own;
//   2. the system block — caches tools+system up to and including it.
// Within a run both hit on turns 2..N. The split matters across runs: the
// system prompt now carries optional per-run `context` (see lib/prompt.js), so
// when that differs between runs the system breakpoint misses — but the tools
// prefix, which never changes, still hits via breakpoint (1). With only the
// system breakpoint, a context change would re-bill the tools too.
// Cache hits show up as `cache_read_input_tokens` in usage. The ephemeral cache
// has a ~5-minute TTL that refreshes on each hit, and a miss simply costs full
// input tokens (the prior behavior), so this is upside with no downside.
//
// See DESIGN.md § Providers.

const { buildJsonSchema, hoistRef, postJSON, buildCompletion, buildVisionResult } = require('./_shared');

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_VISION_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 4096;
// Base URL excludes /v1 and we append /v1/messages below — this matches the
// Anthropic SDK's convention (its baseURL is the bare origin), so an
// ANTHROPIC_BASE_URL set for the SDK keeps working. OpenAI's convention is the
// opposite (baseURL includes /v1), which is why the two providers differ here.
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function getConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const baseURL = (process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  return { apiKey, baseURL };
}

// Anthropic tool format: { name, description, input_schema } — note the key is
// input_schema, not the OpenAI-style nested function/parameters shape.
function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: buildJsonSchema(tool.inputSchema),
  };
}

// Map tools to Anthropic's format and mark the LAST one with a cache breakpoint,
// so the tool-definitions prefix is cached independently of the system block
// (see the caching note in the file header). cache_control attaches to the last
// tool because the breakpoint caches everything up to and including it.
function toAnthropicTools(tools) {
  const out = (tools || []).map(toAnthropicTool);
  if (out.length) {
    const last = out.length - 1;
    out[last] = { ...out[last], cache_control: { type: 'ephemeral' } };
  }
  return out;
}

// The engine's generic content blocks already match Anthropic's native shape
// (tool_use / tool_result), so message translation is just dropping the
// system messages — those go in a top-level `system` field instead.
function toAnthropicMessages(messages) {
  return messages.filter(m => m.role !== 'system');
}

function parseActions(content) {
  const actions = [];
  for (const block of content || []) {
    if (block.type !== 'tool_use') continue;
    const { ref, args } = hoistRef(block.input || {});
    const action = { kind: 'action', verb: block.name, args };
    if (ref !== undefined) action.ref = ref;
    action.toolUseId = block.id;
    actions.push(action);
  }
  return actions;
}

async function callModel(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_MODEL;
  const { apiKey, baseURL } = getConfig();

  const body = {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,  // forced deterministic
    // System as a single cache-marked text block (see header note). A bare
    // string would also work but can't carry cache_control.
    system: req.system
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]
      : undefined,
    tools: toAnthropicTools(req.tools),
    messages: toAnthropicMessages(req.messages || []),
  };

  const data = await postJSON(`${baseURL}/v1/messages`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body,
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    label: 'Anthropic API',
  });

  // Anthropic returns content as an array of blocks. Tool calls are `tool_use`
  // blocks (→ actions); any `text` blocks are the model's prose, which we join.
  // A safety refusal surfaces as stop_reason 'refusal' rather than a field.
  const proseText = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim() || null;

  return buildCompletion({
    provider: 'anthropic',
    model,
    raw: data,
    start,
    actions: parseActions(data.content),
    text: proseText,
    refusal: data.stop_reason === 'refusal' ? (proseText || 'model refused') : null,
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? null,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? null,
    },
  });
}

// Single-shot image description (Messages API, base64 image block). No tools,
// no history — see lib/vision.js for the orchestration around it.
async function describe(req) {
  const start = Date.now();
  const model = req.model || DEFAULT_VISION_MODEL;
  const { apiKey, baseURL } = getConfig();

  const data = await postJSON(`${baseURL}/v1/messages`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body: {
      model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: req.prompt },
          { type: 'image', source: { type: 'base64', media_type: req.mimeType || 'image/png', data: req.imageBase64 } },
        ],
      }],
    },
    signal: req.signal,
    label: 'Vision (Anthropic)',
  });

  const textBlock = (data.content || []).find(b => b.type === 'text');
  return buildVisionResult({
    provider: 'anthropic',
    model,
    raw: data,
    start,
    text: (textBlock?.text || '').trim(),
    usage: {
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
      cacheReadTokens: data.usage?.cache_read_input_tokens ?? null,
    },
  });
}

const capabilities = {
  reasoningEffort: false,   // ignored today; surfaced so dispatch won't silently drop it
  vision: true,
  toolUse: 'native',
  cache: 'explicit',
};

/** @type {import('./types').Adapter} */
module.exports = {
  name: 'anthropic',
  defaultModel: DEFAULT_MODEL,
  defaultVisionModel: DEFAULT_VISION_MODEL,
  capabilities,
  callModel,
  describe,
  toAnthropicTools,
};
