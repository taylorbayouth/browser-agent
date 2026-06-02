'use strict';

// Validate Action[] against the registry and a Brief's lookup table.
//
// Returns { ok: Action[], errors: { action, error }[] } — never throws.
// The Loop is responsible for formatting errors back into the next turn's
// prompt so the LLM can correct.
//
// See DESIGN.md § Loop semantics § Failure handling.

const REF_RE = /^@[etrv]\d+$/;
const MAX_INTENT_WORDS = 14;

// The model occasionally emits a ref without its leading "@" (e.g. "e4" or
// "t2"), which is otherwise a well-formed ref. Coerce that one case to the
// canonical form so a missing "@" doesn't cost a wasted turn. Anything else is
// left untouched for REF_RE to reject.
function normalizeRef(ref) {
  return typeof ref === 'string' && /^[etrv]\d+$/.test(ref) ? '@' + ref : ref;
}

function checkArgs(args, schema) {
  const provided = new Set(Object.keys(args || {}));
  for (const [key, type] of Object.entries(schema || {})) {
    const optional = type.endsWith('?');
    const baseType = optional ? type.slice(0, -1) : type;
    const value = args ? args[key] : undefined;
    if (value === undefined || value === null) {
      if (!optional) return `missing required arg "${key}" (${baseType})`;
      continue;
    }
    if (baseType === 'string' && typeof value !== 'string') return `arg "${key}" must be string, got ${typeof value}`;
    if (baseType === 'number' && typeof value !== 'number') return `arg "${key}" must be number, got ${typeof value}`;
    if (baseType === 'boolean' && typeof value !== 'boolean') return `arg "${key}" must be boolean, got ${typeof value}`;
    provided.delete(key);
  }
  // Extra args are tolerated — the LLM sometimes passes redundant fields.
  // The executor will ignore them. Strict mode could be added later.
  return null;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function validate(actions, lookup, registry) {
  const ok = [];
  const errors = [];

  if (!Array.isArray(actions)) {
    return { ok, errors: [{ action: actions, error: 'actions must be an array' }] };
  }

  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      errors.push({ action, error: 'action must be an object' });
      continue;
    }
    const verb = action.verb;
    const spec = registry[verb];

    if (!spec) {
      errors.push({ action, error: `unknown verb "${verb}"` });
      continue;
    }

    // requiresRef: the ref is mandatory. optionalRef: the verb accepts a ref but
    // works without one (take_screenshot crops to the ref when given, captures
    // the whole viewport when not). In both cases, a ref that IS present must be
    // well-formed, of an allowed type, and resolvable in the snapshot.
    const refPresent = action.ref != null && action.ref !== '';
    if (spec.requiresRef || (spec.optionalRef && refPresent)) {
      const ref = normalizeRef(action.ref);
      if (ref !== action.ref) action.ref = ref;  // canonicalize for executor + lookup
      if (!ref) {
        if (spec.requiresRef) { errors.push({ action, error: `verb "${verb}" requires a ref` }); continue; }
      } else {
        if (!REF_RE.test(ref)) { errors.push({ action, error: `ref "${ref}" does not match /^@[etrv]\\d+$/` }); continue; }
        const refType = ref[1];
        if (!spec.refType.includes(refType)) {
          errors.push({ action, error: `verb "${verb}" requires ref type ${spec.refType.map(t => '@' + t).join(' or ')}, got "${ref}"` });
          continue;
        }
        if (!(ref in lookup)) { errors.push({ action, error: `ref "${ref}" not present in current snapshot's lookup` }); continue; }
      }
    }

    const needsIntent = verb !== 'done';
    const argErr = checkArgs(action.args, needsIntent ? { intent: 'string', ...(spec.args || {}) } : (spec.args || {}));
    if (argErr) { errors.push({ action, error: argErr }); continue; }
    if (needsIntent && !action.args.intent.trim()) {
      errors.push({ action, error: 'arg "intent" must not be empty' });
      continue;
    }
    if (needsIntent && wordCount(action.args.intent) > MAX_INTENT_WORDS) {
      errors.push({ action, error: `arg "intent" must be under 15 words` });
      continue;
    }

    ok.push(action);
  }

  return { ok, errors };
}

module.exports = { validate, REF_RE, wordCount, MAX_INTENT_WORDS };
