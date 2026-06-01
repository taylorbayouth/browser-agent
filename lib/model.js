'use strict';

// Thin provider facade — the single call primitive every model role goes
// through (planner, vision, plan-of-action, reflect, report). Picks a provider
// module by name, forwards the call, and returns the Completion artifact
// unchanged. No translation lives here — that's each provider's job.
//
// NOTE: this is the model-call primitive (callModel), NOT the run's plan of
// action — that's lib/planning.js. The two were deliberately separated; keep
// them apart.
//
// Also exports toolsFromRegistry(actions) which turns the action registry into
// the generic tool-definition shape consumed by providers.

// The registry is built by providers/index.js, where each adapter self-registers
// and is shape-checked. It's a mutable object: tests inject a fake adapter via
// `modelMod.providers.fake = {...}`, so keep the bare-object lookup below.
const { providers } = require('./providers');

// Default provider. Override per-call via the `provider` arg, or globally via
// the BROWSER_AGENT_PROVIDER env var (mirrors BROWSER_AGENT_EXECUTOR).
const DEFAULT_PROVIDER = 'openai';
const INTENT_ARG = { intent: 'string' };

function toolsFromRegistry(actions) {
  const tools = [];
  for (const [name, spec] of Object.entries(actions)) {
    const inputSchema = {};
    if (spec.requiresRef) inputSchema.ref = 'string';
    else if (spec.optionalRef) inputSchema.ref = 'string?';
    Object.assign(inputSchema, INTENT_ARG);
    for (const [k, v] of Object.entries(spec.args || {})) inputSchema[k] = v;
    tools.push({
      name,
      description: spec.description || '',
      inputSchema,
    });
  }
  return tools;
}

// Warn at most once per (provider, field) so a 30-turn run doesn't spam stderr.
const warnedDrops = new Set();
function warnOnce(provider, field, detail) {
  const key = `${provider}:${field}`;
  if (warnedDrops.has(key)) return;
  warnedDrops.add(key);
  process.stderr.write(`[browser-agent] ${provider} does not support ${field}; ${detail}\n`);
}

// Drop request fields the chosen adapter can't use, with a one-time warning,
// instead of forwarding them to be silently ignored by the provider. Reads
// adapter.capabilities; adapters without it (e.g. a partial test stub) are left
// untouched. Returns the request to forward — a shallow clone only when a field
// was actually stripped, so the caller's object is never mutated.
function applyCapabilities(mod, req) {
  const caps = mod.capabilities;
  if (!caps) return req;
  let out = req;
  if (req.reasoningEffort != null && caps.reasoningEffort === false) {
    warnOnce(mod.name, 'reasoningEffort', 'ignoring it for this call');
    out = { ...out, reasoningEffort: null };
  }
  return out;
}

async function callModel(req, { provider } = {}) {
  const name = provider || process.env.BROWSER_AGENT_PROVIDER || DEFAULT_PROVIDER;
  const mod = providers[name];
  if (!mod) throw new Error(`Unknown provider: ${name} (have: ${Object.keys(providers).join(', ')})`);
  return mod.callModel(applyCapabilities(mod, req));
}

module.exports = { callModel, toolsFromRegistry, providers, DEFAULT_PROVIDER };
