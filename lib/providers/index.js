'use strict';

// Provider registry. Each adapter self-registers here so adding a provider is a
// one-line require + register() rather than editing a map in model.js.
//
// The registry is a plain, MUTABLE object keyed by provider name. That mutability
// is contractual: tests inject a fake adapter via `modelMod.providers.fake = {...}`
// (see test/agent.test.js), and model.js does a bare `providers[name]` lookup. Do
// not freeze it or swap it for a Map.
//
// register() runs a shape guard so a malformed adapter fails loudly at load time
// (a clear "missing capabilities" error) instead of throwing deep inside a run.
// The guard is dev-only — set BROWSER_AGENT_SKIP_ADAPTER_CHECK=1 to skip it — and it
// only reads properties, so the production path stays a plain object assignment.
//
// See docs/model-adapters-spec.md § 4 and lib/providers/types.d.ts.

/** @type {Record<string, import('./types').Adapter>} */
const providers = {};

const CACHE_MODES = new Set(['none', 'automatic', 'explicit', 'implicit+explicit']);
const TOOL_MODES = new Set(['native', 'emulated']);

// Validate that an adapter satisfies the contract before it joins the registry.
// Returns the adapter so register() can stay a one-liner. Skipped when
// BROWSER_AGENT_SKIP_ADAPTER_CHECK is set (e.g. for a deliberately partial test stub).
function assertAdapter(adapter) {
  if (process.env.BROWSER_AGENT_SKIP_ADAPTER_CHECK) return adapter;
  const where = `adapter "${adapter && adapter.name ? adapter.name : '(unknown)'}"`;
  if (!adapter || typeof adapter !== 'object') throw new Error(`Invalid ${where}: not an object`);
  if (typeof adapter.name !== 'string' || !adapter.name) throw new Error(`Invalid ${where}: missing name`);
  if (typeof adapter.defaultModel !== 'string' || !adapter.defaultModel) {
    throw new Error(`Invalid ${where}: missing defaultModel`);
  }
  if (typeof adapter.callModel !== 'function') throw new Error(`Invalid ${where}: callModel() must be a function`);
  const caps = adapter.capabilities;
  if (!caps || typeof caps !== 'object') throw new Error(`Invalid ${where}: missing capabilities`);
  if (typeof caps.reasoningEffort !== 'boolean') throw new Error(`Invalid ${where}: capabilities.reasoningEffort must be boolean`);
  if (typeof caps.vision !== 'boolean') throw new Error(`Invalid ${where}: capabilities.vision must be boolean`);
  if (!TOOL_MODES.has(caps.toolUse)) throw new Error(`Invalid ${where}: capabilities.toolUse must be one of ${[...TOOL_MODES].join('|')}`);
  if (!CACHE_MODES.has(caps.cache)) throw new Error(`Invalid ${where}: capabilities.cache must be one of ${[...CACHE_MODES].join('|')}`);
  if (caps.vision && typeof adapter.describe !== 'function') {
    throw new Error(`Invalid ${where}: capabilities.vision is true but describe() is missing`);
  }
  return adapter;
}

// Register an adapter under its own name. Last registration wins, so a test or
// custom build can override a built-in by re-registering the same name.
function register(adapter) {
  assertAdapter(adapter);
  providers[adapter.name] = adapter;
  return adapter;
}

// Built-in adapters self-register on require.
register(require('./openai'));
register(require('./anthropic'));
register(require('./ollama'));
register(require('./gemini'));
register(require('./openrouter'));

module.exports = { providers, register, assertAdapter };
