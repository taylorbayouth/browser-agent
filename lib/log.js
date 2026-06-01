'use strict';

// Per-run logging. Writes two artifacts under `dir` (default ./logs):
//   latest.jsonl  — one JSON line per turn, overwritten each run
//   latest.json   — the final run artifact, overwritten each run
//
// Appends are synchronous on purpose: turn volume is tiny and we want each line
// on disk before the next action, so an interrupted run loses nothing.

const fs = require('fs');
const path = require('path');

function createLogger({ enabled = true, dir = path.resolve(process.cwd(), 'logs') } = {}) {
  if (!enabled) {
    return { event() {}, finalize() {}, turnsPath: null, latestPath: null };
  }
  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);
  fs.mkdirSync(dir, { recursive: true });
  const turnsPath = path.join(dir, 'latest.jsonl');
  try { fs.writeFileSync(turnsPath, ''); } catch (_) {}
  const latestPath = path.join(dir, 'latest.json');
  let warned = false;

  function warn(err) {
    if (warned) return;
    warned = true;
    process.stderr.write(`[log] failed to write run log: ${err.message}\n`);
  }

  function event(obj) {
    try {
      fs.appendFileSync(turnsPath, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
    } catch (err) { warn(err); }
  }

  function finalize(runArtifact) {
    try { fs.writeFileSync(latestPath, JSON.stringify(forFile(runArtifact), null, 2)); } catch (err) { warn(err); }
    event({
      kind: 'run-final',
      status: runArtifact.status,
      result: runArtifact.result ?? null,
      error: runArtifact.error ?? null,
      stats: runArtifact.stats,
    });
  }

  return { event, finalize, turnsPath, latestPath };
}

// Collapse a step error into a signature so the same failure across turns groups:
// digit runs (coords, ids) → '#', so "covered at (883,231)" and "(510,521)" merge.
function errorSignature(msg) {
  return String(msg).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// A small at-a-glance summary so the story of a run is readable without scanning
// every step and completion: how it ended, what failed, and what it pivoted on.
function buildOutcome(artifact) {
  const steps = Array.isArray(artifact.steps) ? artifact.steps : [];
  const errs = {};
  let failedSteps = 0;
  for (const s of steps) {
    const e = s?.observation?.error;
    if (!e) continue;
    failedSteps++;
    const sig = errorSignature(e);
    errs[sig] = (errs[sig] || 0) + 1;
  }
  const errorSignatures = Object.entries(errs)
    .sort((a, b) => b[1] - a[1])
    .map(([signature, count]) => ({ count, signature }));
  return {
    status: artifact.status ?? null,
    fatalError: artifact.error
      ? { type: artifact.errorType ?? null, message: artifact.error }
      : null,
    stepCount: steps.length,
    failedSteps,
    errorSignatures,
    reflections: Array.isArray(artifact.reflections) ? artifact.reflections.length : 0,
    recordsSaved: Array.isArray(artifact.records) ? artifact.records.length : 0,
    recordTarget: artifact.recordContract?.target ?? null,
  };
}

// Shape the run artifact for latest.json: surface a derived `outcome` summary up
// top, and strip the per-completion `raw.tools` echo (the full tool schema, byte-
// identical every turn — the dominant source of file bloat) down to a single
// top-level `toolSchema`. Never mutates the caller's artifact.
function forFile(artifact) {
  if (!artifact || typeof artifact !== 'object') return artifact;
  let toolSchema = null;
  const completions = Array.isArray(artifact.completions)
    ? artifact.completions.map((c) => {
        if (!c?.raw || typeof c.raw !== 'object' || !('tools' in c.raw)) return c;
        const { tools, ...raw } = c.raw;
        if (tools && !toolSchema) toolSchema = tools;
        return { ...c, raw };
      })
    : artifact.completions;
  const out = { ...artifact, outcome: buildOutcome(artifact), completions };
  if (toolSchema) out.toolSchema = toolSchema;
  return out;
}

module.exports = { createLogger, buildOutcome, errorSignature, forFile };
