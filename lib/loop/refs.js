'use strict';

const actions = require('../actions');

// Ref/identity helpers: resolve a snapshot ref to its node and human name, derive
// stable keys for the no-op/repeat guards, and shape save metadata. Refs change
// every snapshot, so the guards key on accessible name or rounded center instead.

function actionArgsForIdentity(action) {
  const args = { ...(action?.args || {}) };
  delete args.intent; // metadata must not weaken no-op/repeated-action guards
  return args;
}

// Resolve a ref to its node from the brief it was acted on (elements, text, or
// regions), so the log reads `clicked "Sign in"` rather than `clicked @e4`.
function refNode(brief, ref) {
  if (!ref) return null;
  return [
    ...(brief.elements || []),
    ...(brief.text || []),
    ...(brief.regions || []),
  ].find(n => n.ref === ref) || null;
}

function refName(brief, ref) {
  const node = refNode(brief, ref);
  return node?.name || node?.description || null;
}

function saveMetadata(brief, action, extra = {}) {
  const node = refNode(brief, action?.ref);
  const meta = {
    url: brief?.url || undefined,
    title: brief?.title || undefined,
    ref: action?.ref || undefined,
    role: node?.role || undefined,
    name: node?.name || undefined,
    description: node?.description || undefined,
    source_ref: node?.sourceRef || undefined,
    ...extra,
  };
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value != null && value !== ''));
}

function manifestRecordState(scratchpad) {
  const raw = scratchpad?.readManifest?.();
  if (!raw) return { records: 0, unassigned: 0 };
  try {
    const manifest = JSON.parse(raw);
    return {
      records: Array.isArray(manifest.records) ? manifest.records.length : 0,
      unassigned: Array.isArray(manifest.unassigned) ? manifest.unassigned.length : 0,
    };
  } catch {
    return { records: 0, unassigned: 0 };
  }
}

function runMode(recordState) {
  return (recordState.records > 0 || recordState.unassigned > 0) ? 'record' : null;
}

// Stable identity for a target across snapshots. Refs can change every snapshot,
// so key on the accessible name or rounded center when possible.
function targetKey(brief, ref) {
  if (!ref) return null;
  const node = refNode(brief, ref);
  let id = `ref:${ref}`;
  if (node?.name) {
    id = `n:${node.name}`;
  } else if (node?.bbox) {
    const b = Array.isArray(node.bbox)
      ? { x: node.bbox[0], y: node.bbox[1], width: node.bbox[2], height: node.bbox[3] }
      : node.bbox;
    id = `xy:${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`;
  }
  return id;
}

// Stable identity for an action across snapshots, so we can tell when the model
// repeats the *same* target.
function actionKey(brief, action) {
  if (!action) return null;
  const args = JSON.stringify(actionArgsForIdentity(action));
  const id = action.ref ? targetKey(brief, action.ref) : null;
  return action.ref ? `${action.verb}|${id}|${args}` : `${action.verb}|${args}`;
}

function idempotentReadKey(brief, action) {
  if (!action || actions[action.verb]?.idempotentRead !== true) return null;
  if (action.verb === 'take_screenshot') {
    return action.ref ? `${action.verb}|${targetKey(brief, action.ref)}` : `${action.verb}|viewport`;
  }
  return action.verb;
}

module.exports = {
  actionArgsForIdentity,
  refNode,
  refName,
  saveMetadata,
  manifestRecordState,
  runMode,
  targetKey,
  actionKey,
  idempotentReadKey,
};
