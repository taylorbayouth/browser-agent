'use strict';

const { computeBriefHash, computeContentFingerprint } = require('../reduce');
const { waitUntilLoaded } = require('../executors/page');
const { cleanUrl } = require('../url');
const { isSparseBrief } = require('./signals');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function extractBrief(session, allowFreshTab = true) {
  // Re-pin to the frontmost tab first, so a new-tab navigation from the last
  // action is what we perceive (not the stale tab the click started on).
  // allowFreshTab gates following a brand-new no-opener tab (see chooseTab): true
  // right after we act, false while idle-polling so a user-opened tab can't hijack.
  if (session.followActiveTab) {
    let switched = false;
    // Best-effort: a tab-follow failure must not break the turn, but swallowing it
    // silently leaves a later wrong-tab extract undiagnosable — surface it.
    try { switched = await session.followActiveTab(allowFreshTab); }
    catch (err) { console.error(`  (tab-follow failed: ${err?.message || err})`); }
    // A switch lands us on a tab that may still be loading (a click that opened
    // a new tab, an OAuth popup). The turn-1 and navigate gates don't cover a
    // mid-loop switch, so without this the brief is extracted with a blank/stale
    // url+title. Bounded by NAV_LOAD_TIMEOUT_MS and best-effort — never blocks.
    if (switched) {
      try { await waitUntilLoaded(session.client); } catch {}
    }
  }
  const brief = await session.extract({ format: 'lean', inViewportOnly: true });
  brief.briefHash = brief.briefHash ?? computeBriefHash(brief);
  // Content fingerprint is URL-independent: same page at a different cache-busted URL
  // hashes identically. Computed once here so every downstream consumer (visitCounts,
  // screenshotReads) gets the same stable value without re-running the hash.
  brief.contentFingerprint = brief.contentFingerprint ?? computeContentFingerprint(brief);
  return brief;
}

// Get the next brief, short-circuiting redundant LLM work. While the page is
// byte-identical to what the model last acted on (`lastHash`), we poll every
// `pollMs` instead of re-prompting with input that would yield the same answer.
// Returns as soon as the page changes, or after `maxNoChangePolls` polls — a
// genuinely static page then falls through so the model can try something else
// or finish. `lastHash == null` (first turn, or after a no-op/validation error)
// always returns immediately.
// Returns { brief, changed }. `changed` is false only when we gave up waiting
// for a still-identical page (maxNoChangePolls) — i.e. the last action had no
// visible effect. The loop uses that to detect a model repeating a dead action.
async function nextChangedBrief(session, lastHash, loopCfg) {
  // First extract of the turn follows the action we just executed, so allow
  // following a brand-new tab that action may have opened (target=_blank).
  let brief = await extractBrief(session, true);
  if (!loopCfg.shortCircuitOnNoChange || lastHash == null) return { brief, changed: true };

  let polls = 0;
  while (brief.briefHash === lastHash) {
    if (polls >= loopCfg.maxNoChangePolls) {
      return { brief, changed: false };
    }
    polls++;
    await sleep(loopCfg.pollMs);
    // Idle poll: do NOT follow a brand-new tab here — a tab the user opens in the
    // background mid-wait would otherwise steal the session (popups/OAuth still
    // follow via the always-on opener path).
    brief = await extractBrief(session, false);
  }
  return { brief, changed: true };
}

async function retrySparseNavigationBrief(session, brief, prevUrl, loopCfg) {
  const maxRetries = Math.max(0, loopCfg.maxSparsePageRetries ?? 0);
  const retryMs = Math.max(0, loopCfg.sparsePageRetryMs ?? 0);
  const prev = cleanUrl(prevUrl, { max: 0 });
  const cur = cleanUrl(brief.url, { max: 0 });
  if (!maxRetries || !prev || !cur || prev === cur || !isSparseBrief(brief, loopCfg)) return brief;

  let current = brief;
  for (let i = 0; i < maxRetries && isSparseBrief(current, loopCfg); i++) {
    await sleep(retryMs);
    current = await extractBrief(session, false);
  }
  return current;
}

module.exports = {
  extractBrief,
  nextChangedBrief,
  retrySparseNavigationBrief,
};
