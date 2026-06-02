'use strict';

const { cleanUrl } = require('../url');
const { compactWhitespace } = require('./format');

// Flailing-detection signals derived from a single step or brief: sparse-page
// detection and scroll thrash/oscillation. Pure functions — the loop owns the
// mutable state they read and write.

function briefNodeCount(brief) {
  return (brief.elements?.length || 0) + (brief.text?.length || 0) + (brief.regions?.length || 0);
}

function isSparseBrief(brief, loopCfg) {
  return briefNodeCount(brief) < (loopCfg.sparsePageMinNodes ?? 2);
}

function normalizeScrollDirection(action) {
  return compactWhitespace(action.args?.direction || 'down').toLowerCase();
}

// Detect a scroll *thrash* and, separately, a long monotonic scroll run.
//
// The reliable "lost / flailing" signal is OSCILLATION — scrolling down, then
// back up, then down again — not raw scroll count. A long page legitimately
// needs many scrolls in ONE direction to read, so monotonic runs (all down, or
// all up) never escalate; they earn only a soft, one-shot nudge. We count
// direction *reversals* on the same URL and reset the moment any non-scroll
// action runs or the page changes (both mean the model is making progress).
//
// Returns { warn, escalate }: `warn` is advisory text for the event log;
// `escalate` is true once reversals cross maxScrollReversals, signalling the
// caller to fire a reflection turn.
function scrollPatternSignal(step, state, loopCfg) {
  const reflectAt = loopCfg.maxScrollReversals ?? 0;       // oscillation → reflect
  const warnAt = loopCfg.maxSameDirectionScrolls ?? 0;     // long monotonic run → soft nudge

  if (step.action.verb !== 'scroll') {
    // A click/type/navigate/save means real progress — forget the scroll history.
    state.url = null; state.lastDir = null; state.reversals = 0;
    state.runDir = null; state.runLen = 0; state.warned = false;
    return { warn: null, escalate: false };
  }

  const url = cleanUrl(step.url, { max: 0 }) || '';
  const dir = normalizeScrollDirection(step.action);
  if (state.url !== url) {
    // New page: start fresh. This first scroll is run length 1, zero reversals.
    state.url = url; state.lastDir = dir; state.reversals = 0;
    state.runDir = dir; state.runLen = 1; state.warned = false;
    return { warn: null, escalate: false };
  }

  // Reversal accounting (the escalation signal).
  if (state.lastDir && dir !== state.lastDir) state.reversals++;
  state.lastDir = dir;

  // Monotonic-run accounting (the soft-warning signal only).
  if (state.runDir === dir) state.runLen++;
  else { state.runDir = dir; state.runLen = 1; }

  let warn = null;
  if (warnAt && state.runLen >= warnAt && !state.warned) {
    state.warned = true;
    warn = `WARNING: scrolled ${dir} ${state.runLen}x on this page without finding the target; if it isn't here, save what's useful, go back, or finish.`;
  }

  const escalate = reflectAt > 0 && state.reversals >= reflectAt;
  return { warn, escalate };
}

module.exports = {
  briefNodeCount,
  isSparseBrief,
  normalizeScrollDirection,
  scrollPatternSignal,
};
