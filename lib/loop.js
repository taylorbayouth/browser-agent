'use strict';

const crypto = require('crypto');
const actions = require('./actions');
const { buildSystemPrompt } = require('./prompt');
const { reduce } = require('./reduce');
const { callModel, toolsFromRegistry, providers } = require('./model');
const { validate } = require('./validate');
const { createExecutor } = require('./execute');
const { waitUntilLoaded } = require('./executors/page');
const { deepMerge, DEFAULTS, resolveRole } = require('./config');
const { createLogger } = require('./log');
const { createScratchpad } = require('./scratchpad');
const { reflect, clipSaved } = require('./reflect');
const { generatePlan } = require('./planning');
const { generateReport, fallbackReport } = require('./report');
const { estimateTokens } = require('./tokens');
const { cleanUrl } = require('./url');

// Loop helpers, split by concern (see lib/loop/):
//   format   — pure text shaping (quote, compact*, scrollSummary, fmtTurn)
//   refs     — ref→node/name resolution + stable identity keys for the guards
//   signals  — sparse-page + scroll-thrash detection
//   brief    — snapshot extraction and change-polling
//   describe — action/turn rendering + observation-note builder
//   persist  — write a turn's observations to the scratchpad
const { LOG_URL_MAX, compactWords, fmtTurn } = require('./loop/format');
const { manifestRecordState, runMode, refName, actionKey, idempotentReadKey } = require('./loop/refs');
const { scrollPatternSignal } = require('./loop/signals');
const { nextChangedBrief, retrySparseNavigationBrief } = require('./loop/brief');
const { describeAction, buildTurnMessage, termDesc, observationNote } = require('./loop/describe');
const { persistObservations } = require('./loop/persist');

const TERMINAL_NAV_VERBS = new Set(['click', 'navigate', 'back']);

// Stable page identity: URL path (survives query-param / cache-busting changes) combined
// with the content fingerprint (survives URL variations that don't affect structure).
// Used by visitCounts and screenshotReads so the same logical page is recognised even
// when its URL carries a fresh ?session= or ?trk= each visit.
function briefPageKey(brief) {
  let pathname = '';
  try { pathname = brief?.url ? new URL(String(brief.url)).pathname : ''; } catch {}
  return `${pathname}|${brief?.contentFingerprint ?? ''}`;
}

// The orchestrator. The only stateful piece of the engine. Everything else
// is a pure function of its inputs.
//
// Loop body (DESIGN.md § Loop semantics):
//   1. extract snapshot
//   2. reduce → LLMView
//   3. build messages from history + LLMView
//   4. plan → Completion (LLM call)
//   5. validate completion.actions against snapshot.lookup
//   6. execute → Observations
//   7. record Steps; if `done`, exit; else repeat
//
// See DESIGN.md § Message conversion for the per-turn message shape.

// The agent's memory is NOT a transcript of every page it has seen — that grows
// quadratically (each turn would re-send every prior snapshot). Instead we keep
// a compact, deterministic event log of what *happened* ("typed … into …",
// "clicked …", "navigated to …") plus ONLY the current page. The log is derived
// from Steps the loop already has, so it costs no extra LLM call.

// `config` is the merged knob set (see lib/config.js). Callers (agent.js) layer
// CLI flags on top before passing it in. Partial config is fine — it's merged
// over DEFAULTS here so library callers can pass just { provider } etc.
async function run({ session, task, config = {} } = {}) {
  if (!session) throw new Error('run() requires a session');
  if (!task) throw new Error('run() requires a task');

  // Single output channel keeps terminal progress formatting consistent.
  const emit = (msg) => console.error(msg);

  const cfg = deepMerge(DEFAULTS, config);
  const primaryCfg = cfg.models.primary;
  const provider = primaryCfg.provider;          // undefined never happens (DEFAULTS sets it)
  const model = primaryCfg.model || undefined;   // null/empty → provider's own default
  const loopCfg = cfg.loop;

  // `system` (the planner's prompt) is built later, after Step 0 produces the
  // plan, so the immutable plan rides along inside the cached system prefix on
  // every turn (see the Step-0 block below and lib/prompt.js).
  const tools = toolsFromRegistry(actions);
  const exec = createExecutor({ ...(cfg.executor || {}) }, cfg.settle || {});

  const runArtifact = {
    kind: 'run',
    version: '1.0',
    id: crypto.randomUUID(),
    task,
    model: model || 'default',
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    plan: null,                 // Step 0's plan of action (lib/planning.js); null if disabled/failed
    result: null,
    steps: [],
    completions: [],
    stats: {
      stepCount: 0,
      totalElapsedMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedPromptTokens: 0,
    },
  };

  // Announce the active models up front so the terminal makes it obvious which
  // planner and vision model a run is actually using (resolving null → the
  // provider's own default model id, rather than printing the literal "default").
  // Resolve a role to a "provider:model" label, turning a null model into the
  // provider's own default id rather than printing the literal "default".
  const roleLabel = (role, { vision = false } = {}) => {
    const r = resolveRole(cfg, role);
    const p = r.provider || provider;
    const dflt = vision ? providers[p]?.defaultVisionModel : providers[p]?.defaultModel;
    return `${p}:${r.model || dflt || 'default'}`;
  };
  let modelsLine = `models · planner ${roleLabel('primary')} · vision ${roleLabel('vision', { vision: true })}`;
  if ((cfg.models.reflect || {}).enabled !== false) modelsLine += ` · reflect ${roleLabel('reflect')}`;
  if ((cfg.models.plan || {}).enabled !== false) modelsLine += ` · plan ${roleLabel('plan')}`;
  if ((cfg.models.report || {}).enabled !== false) modelsLine += ` · report ${roleLabel('report')}`;
  emit(modelsLine);

  // Per-run log: streamed JSONL (survives Ctrl-C) + latest.json on finish.
  const logger = createLogger(cfg.log || {});
  if (logger.turnsPath) emit(`logging → ${logger.turnsPath}`);
  logger.event({ kind: 'run-start', task, provider, model: model || 'default' });

  // Per-run scratchpad: text evidence and asset metadata land in one manifest.
  // Binary evidence stays in assets/; the final report pass reads the manifest.
  const scratchpad = createScratchpad({ ...(cfg.scratchpad || {}), runId: runArtifact.id });
  runArtifact.artifacts = {
    runDir: scratchpad.dir || null,
    reportPath: scratchpad.reportPath || null,
    reportHtmlPath: scratchpad.reportHtmlPath || null,
    savedManifestPath: scratchpad.manifestPath || null,
    assetsDir: scratchpad.assetsDir || null,
    logPath: logger.latestPath || null,
    jsonlPath: logger.turnsPath || null,
  };

  let iter = 0;
  // Hash of the page the model last acted on. null forces an immediate prompt
  // (first turn, or after a no-op / validation error where waiting is pointless
  // because nothing executed to change the page).
  let lastHash = null;
  // Compact "what happened" memory, rebuilt into each turn's prompt instead of
  // an ever-growing transcript of past snapshots (see buildTurnMessage).
  const events = [];
  let prevUrl = null;          // for detecting navigation between turns (URL-level)
  let prevPageKey = null;      // content-fingerprint key of the previous turn's page (for visitCounts)
  // (Re-)arrivals per fragment-stripped URL — navigating IN counts, staying on a
  // page to scroll/read does not. Drives the revisit warning in the turn message
  // that stops the agent looping back to pages it has already inspected.
  const visitCounts = new Map();
  // No-op loop guard: the stable key of the action executed last turn, and how
  // many times in a row the model has re-picked it while the page stayed put.
  let lastActionKey = null;
  // Read-key + page hash of the last executed action, so we can also catch a
  // changesPage:false read being repeated on an unchanged page.
  let lastReadKey = null;
  let lastActionBriefHash = null;
  let stuckStreak = 0;
  // Companion to the no-op guard for actions that ERROR rather than no-op (e.g. a
  // click whose target is covered by a sticky overlay). An errored action nulls
  // lastHash + lastActionKey below — which forces `changed` true and wipes
  // `sameAction` next turn — so the no-op guard can never count a *repeated
  // erroring* action. lastErroredKey is the stable key of the primary action that
  // errored last turn; re-planning it folds into stuckStreak and the same abort.
  let lastErroredKey = null;
  let emptyPlanStreak = 0;
  const scrollLoopState = { url: null, lastDir: null, reversals: 0, runDir: null, runLen: 0, warned: false };
  // Per-(page, region) screenshot read counter. Key: "${cleanUrl}|${ref || 'viewport'}".
  // Persists across reflections so the model cannot indefinitely reset the idempotent-read guard
  // by triggering pivots — each successive screenshot of the same region on the same page
  // still accumulates and yields a strong event-log warning.
  const screenshotReads = new Map();
  let blockedDoneForUnassignedRecordKey = null;
  let lastExecutedVerb = null;

  // Reflection state (see maybeReflect + lib/reflect.js).
  const reflectCfg = cfg.models.reflect || {};
  let reflectCount = 0;          // reflections fired this run (capped)
  let lastReflectTurn = -Infinity; // for the cooldown between reflections
  let budgetReflected = false;   // the one budget-threshold reflection has fired
  // The latest reflection decision, awaiting a single turn of prominence. Set by
  // maybeReflect, rendered once as a highlighted directive by buildTurnMessage,
  // and cleared on render — so the pivot drives exactly the turn that follows the
  // reflection (the forced fresh extract), then ages out instead of lingering.
  let pendingPivot = null;
  // Absolute ceiling on loop passes — counts EVERYTHING, including reflection
  // turns that are refunded from maxSteps below, so a run can never spin forever
  // (e.g. uncounted reads) even though reflections don't consume the step budget.
  let totalIterations = 0;
  const maxIterations = loopCfg.maxIterations
    ?? (loopCfg.maxSteps + (reflectCfg.maxReflections ?? 0) + 10);

  // Fire a reflection turn if the guards allow (enabled, under the per-run cap,
  // past the cooldown). On success it pushes the model's decision into the event
  // log as a permanent step, resets the flailing guards, and forces a fresh
  // extract next turn so the pivot acts on a real page. Returns true if it fired;
  // callers then refund the step budget (iter--) and `continue` to re-plan.
  async function maybeReflect(reason, brief, hint = null) {
    if (reflectCfg.enabled === false) return false;
    if (reflectCount >= (reflectCfg.maxReflections ?? 10)) return false;
    if (totalIterations - lastReflectTurn < (reflectCfg.cooldownTurns ?? 4)) return false;

    const saved = clipSaved(scratchpad.readManifest?.() || '', reflectCfg.savedMaxChars ?? 16000);
    // The reflection turn can run on its own provider/model (a stronger model to
    // think on, independent of the planner). null falls back to the planner's.
    const { provider: reflectProvider, model: reflectModel } = resolveRole(cfg, 'reflect');
    let decision = '';
    try {
      const { text, completion } = await reflect({
        task, plan: runArtifact.plan, url: brief?.url, title: brief?.title, saved, hint,
        provider: reflectProvider, model: reflectModel,
        cacheKey: 'browser-agent:reflect',
        reasoningEffort: reflectCfg.reasoningEffort, maxTokens: reflectCfg.maxTokens, timeoutMs: reflectCfg.timeoutMs,
      });
      runArtifact.completions.push(completion);
      runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
      runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
      if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;
      decision = compactWords(text, 15);
    } catch (err) {
      // A reflection failure must never break the run — just skip it and let the
      // normal guard (stuck/empty/max-steps) take over as it would have.
      emit(`  (reflection skipped: ${err?.message || err})`);
      return false;
    }
    if (!decision) return false;

    reflectCount++;
    lastReflectTurn = totalIterations;
    // Hand the decision to the next turn as a highlighted directive rather than
    // burying it in History, where a past-tense bullet among many gets ignored
    // (see buildTurnMessage). pendingPivot is shown once, then cleared.
    pendingPivot = decision;
    const line = `🧭 reflection (${reason}) → ${decision}`;
    events.push(line);
    emit(`\n${line}`);
    logger.event({ kind: 'reflect', turn: iter, reason, decision });

    // Clear the flailing guards and force a fresh extract so the pivot gets a
    // clean turn instead of being immediately re-counted as stuck on the same key.
    lastHash = null;
    lastActionKey = null;
    // lastReadKey and lastActionBriefHash are intentionally NOT cleared here.
    // Resetting them would grant the model a free idempotent-read retry after every
    // reflection: take_screenshot(@r3) → stuck → reflect → lastReadKey=null → model
    // can immediately re-screenshot without the repeatedRead guard firing. Keeping
    // them means the guard stays armed: if the pivot doesn't change the page, the
    // very next same-region screenshot re-trips repeatedRead. If the model navigates
    // to a genuinely new page, its different briefHash clears the guard naturally.
    lastErroredKey = null;
    stuckStreak = 0;
    emptyPlanStreak = 0;
    return true;
  }

  // Shared escalation path for every flailing guard, so the maybeReflect → pivot
  // → fallback dance lives in ONE place instead of being copy-pasted per guard.
  // Tries a reflection turn; if it fires the caller refunds the step (iter--) and
  // re-plans. If reflection is unavailable (capped/cooldown/off), `onUnavailable`
  // decides the fallback:
  //   'abort' — stop the run with the given status/result (stuck, empty-plan).
  //   'warn'  — let the run continue; the guard's own warning text already nudged
  //             the model (budget, scroll-oscillation, url-revisit).
  // Returns 'reflected' | 'aborted' | null; the caller drives loop control flow:
  //   if (e === 'reflected') { iter--; continue; }
  //   if (e === 'aborted')   return await finish(runArtifact, { scratchpad, config: cfg });
  async function escalate(reason, brief, { hint = null, onUnavailable = 'warn', status, result, emitLine, logEvent } = {}) {
    if (await maybeReflect(reason, brief, hint)) return 'reflected';
    if (onUnavailable !== 'abort') return null;
    if (emitLine) emit(emitLine);
    if (logEvent) logger.event(logEvent);
    runArtifact.status = status;
    runArtifact.result = result;
    return 'aborted';
  }

  // A user Ctrl-C (SIGINT) otherwise kills the process before the finally below
  // runs, so latest.json — written only by logger.finalize() — never lands for an
  // interrupted run (the streamed latest.jsonl survives, latest.json does not).
  // Catch the signal, mark the run aborted, and flush the same finish artifacts a
  // clean exit would (fallback report + latest.json) before exiting. These writes
  // are synchronous, so they complete before process.exit. `aborting` guards a
  // double-fire (two fast ^C); removed in the finally so a normal finish — or a
  // repeated run() call, e.g. bench.js — leaves no dangling listener.
  let aborting = false;
  const onSigint = () => {
    if (aborting) return;
    aborting = true;
    emit('\n^C — aborting; flushing run log…');
    runArtifact.status = 'aborted';
    runArtifact.result = runArtifact.result ?? `Aborted by user after ${runArtifact.steps.length} step(s).`;
    runArtifact.endedAt = new Date().toISOString();
    runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
    try {
      const manifest = scratchpad?.readManifest?.() || '';
      runArtifact.report = fallbackReport(runArtifact, manifest, 'Interrupted before final report synthesis', { evidenceSource: 'saved-manifest.json' });
      scratchpad?.writeReport?.(runArtifact.report, { title: runArtifact.task || 'Report' });
    } catch {}
    try { logger.finalize(runArtifact); } catch {}
    try { exec.close(); } catch {}
    process.exit(130);   // 128 + SIGINT(2), the conventional Ctrl-C exit code
  };
  process.on('SIGINT', onSigint);

  try {
    // Inside the try so a failed init (os backend: missing binary / denied
    // Accessibility) is reported as a failed Run and still hits the finally's
    // exec.close() instead of throwing out of run() and leaking the helper.
    await exec.init();

    // Turn-1 readiness: the tab we connect to may still be loading, and the
    // change-poll short-circuits on the first turn (lastHash == null), so without
    // this the very first snapshot could capture a half-loaded page. The navigate
    // gate covers later full loads; this covers the initial cold connect.
    // Best-effort — a readiness failure must never block the run.
    try {
      const reason = await waitUntilLoaded(session.client);
      emit(`\ninit · page ready (${reason})`);
    } catch (err) {
      emit(`\ninit · readiness check skipped: ${err?.message || err}`);
    }

    // ─── Step 0: plan of action ───────────────────────────────────────────────
    // One upfront call (lib/planning.js) that turns the bare task into a short
    // prose plan, formed from the task + trusted context before any page is seen.
    // It's an immutable north star: appended to the planner's system prompt below
    // (cached, every turn), and handed to each reflection (maybeReflect) and the
    // final report (finish) so every stage shares one reading of the task. A
    // failure here must never break the run — proceed with no plan, as before.
    const planCfg = resolveRole(cfg, 'plan');
    if (planCfg.enabled !== false) {
      try {
        const { text, completion } = await generatePlan({
          task,
          context: cfg.context,
          provider: planCfg.provider,
          model: planCfg.model,
          cacheKey: 'browser-agent:plan',
          reasoningEffort: planCfg.reasoningEffort,
          maxTokens: planCfg.maxTokens,
          timeoutMs: planCfg.timeoutMs,
        });
        runArtifact.completions.push(completion);
        runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
        runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
        if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;
        if (text) {
          runArtifact.plan = text;
          logger.event({ kind: 'plan', plan: text });
          emit(`\nplan · ${text}`);
        }
      } catch (err) {
        // Step 0 is an enhancement, never a dependency (see comment above).
        emit(`  (plan skipped: ${err?.message || err})`);
      }
    }

    // Build the planner's prompt now, AFTER Step 0, so the immutable plan rides
    // along inside the cached system prefix on every turn (see lib/prompt.js).
    const system = buildSystemPrompt(actions, cfg.context, runArtifact.plan);

    // ─── Guard map ──────────────────────────────────────────────────────────
    // Every guard that can redirect (reflect) or stop the run lives inline below,
    // placed at the phase where its signal first exists, and fires through the
    // shared escalate() helper. The full set, in turn order:
    //
    //   guard               phase            trips on                          unavailable→
    //   url-revisit         after extract    Nth arrival at same URL           warn (continue)
    //   budget              after extract    iter ≥ maxSteps·budgetTurnFraction warn (continue)
    //   stuck               after plan       same dead/errored action repeated  ABORT
    //   empty-plan          after plan       consecutive turns with no action   ABORT
    //   scroll-oscillation  after execute    down↔up reversals on one page      warn (continue)
    //
    // "unavailable" = what happens when a reflection can't fire (capped/cooldown/
    // disabled). State for these lives just above (visitCounts, stuckStreak,
    // emptyPlanStreak, scrollLoopState, budgetReflected) + maybeReflect's counters.
    while (iter < loopCfg.maxSteps) {
      iter++;
      // Absolute ceiling, counting reflection turns that iter-- refunds below, so
      // the run can never spin forever even as reflections give the step budget back.
      if (++totalIterations > maxIterations) {
        emit(`\nmax iterations (${maxIterations}) reached; aborting`);
        logger.event({ kind: 'max-iterations', turn: iter, totalIterations });
        runArtifact.status = 'max-iterations';
        runArtifact.result = `Stopped: exceeded the hard iteration ceiling (${maxIterations}).`;
        return await finish(runArtifact, { scratchpad, config: cfg });
      }
      if (exec.backend.waitUntilReady) await exec.backend.waitUntilReady();

      // 1. Extract — short-circuits while the page is unchanged (polls instead
      //    of re-prompting). See nextChangedBrief.
      let { brief, changed } = await nextChangedBrief(session, lastHash, loopCfg);
      brief = await retrySparseNavigationBrief(session, brief, prevUrl, loopCfg);

      // If the last action left the page unchanged, tell the model so — annotate
      // its most recent event line. This gives it a chance to pick something
      // else before the stuck-guard below aborts the run.
      if (!changed && lastActionKey && events.length && !events[events.length - 1].endsWith('(no page change)')) {
        events[events.length - 1] += ' (no page change)';
      }

      // Log a navigation event when the URL changed since the last turn.
      if (prevUrl !== null && brief.url && brief.url !== prevUrl) {
        events.push(`page navigated to ${cleanUrl(brief.url, LOG_URL_MAX)}`);
        if (TERMINAL_NAV_VERBS.has(lastExecutedVerb)) emit(`  ↳ ${cleanUrl(brief.url, LOG_URL_MAX)}`);
        // The errored-target guard keys on verb + accessible name, which is not
        // unique across pages ("Submit", "Search"…). Once we've navigated away,
        // last turn's errored target is gone — clear it so a same-named element on
        // the new page can't be miscounted as a repeat and trip a false abort.
        lastErroredKey = null;
      }
      // Count genuine (re-)arrivals per page for the revisit warning. An arrival
      // is the page's content fingerprint changing since last turn (incl. the first
      // turn); staying to scroll/read the same page doesn't count.
      //
      // The page key identifies a logical page for revisit counting.
      //
      // Default mode 'content': combines URL pathname (stable across query-param
      // changes) with the content fingerprint (stable across cache-busting params,
      // session tokens, and redirect wrappers). This handles two distinct failure modes:
      //   • same path, different ?cache= params   → same key (fingerprint + path match)
      //   • different paths, same page structure  → different key (paths differ)
      // Fallback modes: 'clean' (strip tracking params from URL) or 'full' (raw URL).
      const pageKey = (() => {
        const mode = loopCfg.revisitUrlMatch ?? 'content';
        if (mode === 'content') return briefPageKey(brief);
        if (mode === 'full') return brief.url ? String(brief.url) : null;
        return cleanUrl(brief.url, { max: 0 }) ?? null; // 'clean'
      })();
      const arrived = !!pageKey && pageKey !== prevPageKey;
      if (arrived) visitCounts.set(pageKey, (visitCounts.get(pageKey) || 0) + 1);
      prevUrl = brief.url ?? prevUrl;
      prevPageKey = pageKey ?? prevPageKey;
      const visits = pageKey ? (visitCounts.get(pageKey) || 0) : 0;
      const revisits = pageKey ? visits - 1 : 0;

      // Revisit-loop trigger: arriving on a page we've already seen too many times
      // means the agent is circling back instead of progressing — its content is
      // already in the history. Fires only on a fresh arrival (not on scroll/read),
      // and only the once per threshold-crossing (reset on pivot below).
      const maxVisits = loopCfg.maxUrlVisits ?? 0;
      if (arrived && maxVisits && visits >= maxVisits) {
        const hint = `You have arrived on this page ${visits} times now — its content is already in your history above. Re-reading it will not help. Use what you already have, or go somewhere genuinely new (a different source or search).`;
        if (await escalate('url-revisit', brief, { hint }) === 'reflected') {
          visitCounts.set(pageKey, 0); // pivot acknowledged; don't immediately re-fire
          iter--;                     // the reflection turn doesn't consume the step budget
          continue;
        }
      }

      // Budget trigger: once we cross a fraction of the step budget without
      // finishing, pause to ask whether the current approach is still worth it.
      // Fires at most once (independent of the stuck/empty escape hatches below).
      const budgetTurn = Math.floor(loopCfg.maxSteps * (reflectCfg.budgetTurnFraction ?? 0.6));
      if (!budgetReflected && iter >= budgetTurn) {
        if (await escalate('budget', brief) === 'reflected') {
          budgetReflected = true;
          iter--;   // the reflection turn doesn't consume the step budget
          continue;
        }
      }

      // 2. Reduce
      const llmView = reduce(brief, cfg.view);

      // Set BROWSER_AGENT_DEBUG_VIEW=1 to dump the exact condensed listing sent to the
      // LLM — the ground truth for "did the model even see the right element?".
      if (process.env.BROWSER_AGENT_DEBUG_VIEW) {
        console.error(`[view] turn ${iter} — ${llmView.listing.split('\n').length} lines:\n${llmView.listing}`);
      }

      // 3. Plan — the prompt is rebuilt fresh each turn from the event log plus
      //    only the current page (see buildTurnMessage), not a growing transcript.
      const turnMessage = buildTurnMessage(task, events, llmView, revisits, pendingPivot);
      pendingPivot = null;  // shown once; the next reflection sets it again
      const estimatedPromptTokens = estimateTokens(turnMessage);
      const completion = await callModel(
        // cacheKey groups this run's turns for OpenAI prompt caching. Stable for
        // the whole run, so every turn routes to the same warmed prefix. Other
        // providers ignore it — Anthropic caches via explicit breakpoints, and
        // Ollama via automatic local KV-cache prefix reuse (no key parameter);
        // both already benefit from the stable static-first prompt prefix.
        { system, tools, messages: [turnMessage], model, cacheKey: runArtifact.id,
          reasoningEffort: primaryCfg.reasoningEffort, maxTokens: primaryCfg.maxTokens, timeoutMs: primaryCfg.timeoutMs },
        { provider }
      );
      const plannedActions = Array.isArray(completion.actions) ? completion.actions : [];
      const turnActions = plannedActions.slice(0, 1);
      const extraActions = plannedActions.slice(1);
      // Prose the model returned instead of an action (a refusal, or it "thought
      // out loud" without calling a tool). Without this, an action-less turn is a
      // silent blank — surfacing it turns the empty-plan abort from a mystery into
      // the model's own stated reason, and lets it see that note next turn.
      const modelText = (completion.refusal || completion.text || '').trim();
      runArtifact.completions.push(completion);
      runArtifact.stats.totalEstimatedPromptTokens += estimatedPromptTokens;
      runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
      runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
      if (!runArtifact.model || runArtifact.model === 'default') runArtifact.model = completion.model;

      emit(`\n${fmtTurn(iter, loopCfg.maxSteps, completion.usage, runMode(manifestRecordState(scratchpad)))}`);
      if (plannedActions.length) {
        // The planned line is also the action's stated intent — show it ("why"),
        // since the success path no longer re-prints the action (see below).
        emit(`  → ${plannedActions.map(a => {
          const d = termDesc(a, brief);
          const intent = a.args?.intent;
          return intent ? `${d} — ${intent}` : d;
        }).join('; ')}`);
      } else if (modelText) {
        emit(`  (no action) model said: "${modelText.length > 200 ? modelText.slice(0, 199) + '…' : modelText}"`);
      }

      // No-op loop guard. If the page didn't change after our last action and the
      // model is asking to repeat that same action, it's flailing on a dead
      // target. Count consecutive repeats; once we cross the threshold, stop the
      // run cleanly instead of grinding to max-steps (each stuck turn costs a full
      // no-change wait). `done` is never a stuck target.
      const primary = turnActions.find(a => a.verb !== 'done') || null;
      const primaryKey = actionKey(brief, primary);
      // Two stuck shapes:
      //  - the exact same action again after the page didn't change (the original
      //    case — a dead click/press that the change-poll confirms had no effect).
      //  - an `idempotentRead` repeated on a page that hashes identical to the
      //    one it last ran on. Screenshots are keyed by crop target; image/file
      //    listings remain verb-level reads. These null lastHash (so `changed`
      //    is always true and the first test can't catch them).
      const sameAction = !changed && lastActionKey && primaryKey && primaryKey === lastActionKey;
      const primaryReadKey = idempotentReadKey(brief, primary);
      const repeatedRead = primaryReadKey && primaryReadKey === lastReadKey
        && lastActionBriefHash != null && brief.briefHash === lastActionBriefHash;
      // Third stuck shape: re-planning the exact action that ERRORED last turn (a
      // covered click, etc.). Independent of `changed` — an errored action leaves
      // the page untouched yet nulls lastHash, so `changed` is misleadingly true.
      const sameErroredTarget = lastErroredKey && primaryKey && primaryKey === lastErroredKey;
      // Fourth stuck shape: the exact same `type` again, even when `changed` is
      // true. A clear that silently no-ops (e.g. an autocomplete box that drops
      // the select-all) appends instead of replacing, so the field grows — which
      // flips the brief hash and makes `changed` true, masking the loop from the
      // first test. Re-typing identical text into the identical field is never
      // real progress (unlike a repeated click on "Load more", which is why this
      // is gated to `type`), so it counts regardless of `changed`.
      const sameTypeRepeat = primary?.verb === 'type' && lastActionKey && primaryKey === lastActionKey;
      if (sameAction || repeatedRead || sameErroredTarget || sameTypeRepeat) {
        stuckStreak++;
        // For repeated screenshot reads specifically, inject a persistent event-log warning
        // so the model sees it on the next turn (including after a reflection that resets
        // stuckStreak). Varying the hint doesn't produce new information — the region's
        // DOM content is structurally unchanged. Check screenshotReads (set after execution)
        // to know how many times the region has actually been captured.
        if (repeatedRead && primary?.verb === 'take_screenshot') {
          const sk = `${briefPageKey(brief)}|${primary.ref || 'viewport'}`;
          const priorReads = screenshotReads.get(sk) || 0;
          if (priorReads >= 1) {
            const regionDesc = primary.ref ? (refName(brief, primary.ref) || primary.ref) : 'viewport';
            events.push(`⚠ screenshot of "${regionDesc}" already captured ${priorReads + 1}× on this page with no content change — changing the hint will not help; navigate away or use a different action`);
          }
        }
      } else {
        stuckStreak = 0;
      }
      if (stuckStreak >= loopCfg.maxStuckRepeats) {
        // Escape hatch before aborting: a reflection turn to pivot. If it fires,
        // refund the step and re-plan; only abort if reflection is unavailable.
        const desc = describeAction(primary, brief);
        const e = await escalate('stuck', brief, {
          onUnavailable: 'abort',
          status: 'stuck',
          result: `Stopped: repeatedly chose the same action with no effect on the page (${desc}). The target is likely unresponsive or the wrong element.`,
          emitLine: `\nstuck — "${desc}" repeated ${stuckStreak}×; aborting`,
          logEvent: { kind: 'stuck', turn: iter, action: primary, repeats: stuckStreak },
        });
        if (e === 'reflected') { iter--; continue; }
        if (e === 'aborted') return await finish(runArtifact, { scratchpad, config: cfg });
      }

      // 4. Validate
      let { ok: validActions, errors: validationErrors } = validate(turnActions, brief.lookup || {}, actions);
      const errors = [
        ...validationErrors,
        ...extraActions.map(action => ({
          action,
          error: 'ignored: only one action per turn is allowed',
        })),
      ];
      const doneAction = validActions.find(a => a.verb === 'done');
      if (doneAction) {
        const recordState = manifestRecordState(scratchpad);
        const guardKey = `${recordState.records}:${recordState.unassigned}`;
        if (recordState.records > 0 && recordState.unassigned > 0 && blockedDoneForUnassignedRecordKey !== guardKey) {
          blockedDoneForUnassignedRecordKey = guardKey;
          validActions = validActions.filter(a => a !== doneAction);
          errors.push({
            action: doneAction,
            error: `unassigned saved evidence exists (${recordState.unassigned} item${recordState.unassigned === 1 ? '' : 's'}) after ${recordState.records} saved record${recordState.records === 1 ? '' : 's'}; call save_record if it belongs to the current record, or call done again only if it is intentionally unassigned`,
          });
        }
      }

      // 5. Execute the valid actions (none ⇒ nothing to dispatch this turn).
      const observations = validActions.length
        ? await exec.execute(validActions, session, brief)
        : [];

      // Persist saved evidence to the scratchpad and strip heavy payloads (image
      // base64, file bytes, full save_text content) from what re-enters context.
      // Read-only screenshots still return pixels for vision but never land in
      // assets/ unless the model called save_image (see persistObservations).
      await persistObservations({ observations, validActions, brief, scratchpad, runArtifact, cfg });

      // Log the full turn now (before the done-path can return early): the page
      // the model saw, what it planned, what was rejected, and the outcomes.
      logger.event({
        kind: 'turn',
        turn: iter,
        url: brief.url,
        title: brief.title,
        llmPayload: {
          messages: [turnMessage],
          estimatedTokens: estimatedPromptTokens,
        },
        listing: llmView.listing,
        planned: completion.actions,
        rejected: errors.map(e => ({ action: e.action, error: e.error })),
        observations,
        usage: completion.usage || null,
      });

      emptyPlanStreak = plannedActions.length === 0 ? emptyPlanStreak + 1 : 0;
      // Record the model's prose for an action-less turn so it shows up in the
      // event log the model sees next turn.
      if (plannedActions.length === 0 && modelText) {
        events.push(`(no action) model said: "${modelText.length > 300 ? modelText.slice(0, 299) + '…' : modelText}"`);
      }
      if (emptyPlanStreak >= loopCfg.maxEmptyPlans) {
        // Escape hatch before aborting (see the stuck guard above): a reflection
        // turn may unstick a model that keeps returning no action.
        const e = await escalate('empty-plan', brief, {
          onUnavailable: 'abort',
          status: 'empty-plan',
          result: `Stopped: the model returned no actions for ${emptyPlanStreak} consecutive turns.`
            + (modelText ? ` Last message: ${modelText}` : ''),
          emitLine: `\nempty plan repeated ${emptyPlanStreak} turns; aborting`,
          logEvent: { kind: 'empty-plan', turn: iter, repeats: emptyPlanStreak, modelText: modelText || null },
        });
        if (e === 'reflected') { iter--; continue; }
        if (e === 'aborted') return await finish(runArtifact, { scratchpad, config: cfg });
      }

      // 6. Record Steps + append executed events.
      let scrollEscalate = false; // set if this turn's scroll trips the oscillation guard
      for (let i = 0; i < observations.length; i++) {
        const resolvedName = refName(brief, validActions[i].ref);
        const step = { kind: 'step', url: brief.url, title: brief.title, targetName: resolvedName, action: validActions[i], observation: observations[i] };
        runArtifact.steps.push(step);
        runArtifact.stats.stepCount++;

        if (step.action.verb === 'done') {
          runArtifact.status = 'completed';
          runArtifact.result = step.action.args?.result ?? null;
          emit(`  ✓ ${termDesc(step.action, brief)}`);
          return await finish(runArtifact, { scratchpad, config: cfg });
        }

        const failed = step.observation.status === 'error';
        const line = describeAction(step.action, brief);
        const note = observationNote(step);
        const entry = `${line}${note}`;
        events.push(entry);
        // Record successful screenshot reads for the per-page repeat counter.
        // Keyed on (normalised URL, ref) so the count survives reflections and
        // drives the ⚠ warning injected by the stuck-guard on the next repeat.
        if (step.action.verb === 'take_screenshot' && !failed) {
          const sk = `${briefPageKey(brief)}|${step.action.ref || 'viewport'}`;
          screenshotReads.set(sk, (screenshotReads.get(sk) || 0) + 1);
        }
        const scroll = scrollPatternSignal(step, scrollLoopState, loopCfg);
        if (scroll.warn) events.push(scroll.warn);
        if (scroll.escalate) scrollEscalate = true;
        // The planned "→" line already showed the action; only print a result
        // line when it adds something — a failure, or a note the verb produced
        // (saved path, selection, vision summary). A plain success is silent, so
        // the same click/type/navigate URL isn't echoed twice.
        const tDesc = termDesc(step.action, brief, step.observation.detail ? step.observation : undefined);
        if (failed) emit(`  ✗ ${tDesc} — ${step.observation.error}`);
        else if (note && step.action.verb !== 'save_image' && step.action.verb !== 'save_record') emit(`  ✓ ${tDesc}`);
        lastExecutedVerb = step.action.verb;
      }

      // Rejected actions become events too, so the next turn the model sees what
      // it tried and why it was refused (unknown verb, bad ref, wrong arg types).
      for (const { action, error } of errors) {
        const entry = `${describeAction(action, brief)} — rejected: ${error}`;
        events.push(`✗ ${entry}`);
        emit(`  ✗ ${entry}`);
      }

      if (validActions.length === 0) {
        // Nothing executed, so the page can't change. Clear lastHash so the next
        // turn re-prompts immediately instead of polling for a change that will
        // never come. (Still counts toward max-steps — iter already incremented.)
        lastHash = null;
        lastExecutedVerb = null;
        lastActionKey = null;
        lastReadKey = null;
        // Treat the rejected primary like an errored target, keyed on the current
        // page: a model that re-emits the SAME invalid action every turn then
        // trips sameErroredTarget → stuckStreak and aborts, instead of grinding to
        // max-steps re-rejecting it. A different or valid action next turn clears it.
        lastActionBriefHash = brief.briefHash;
        lastErroredKey = primaryKey;
        continue;
      }

      // Remember the page the model just acted on. Next turn's extract is
      // compared against this: if the action changed nothing, we poll/wait; if
      // it changed the page, we proceed immediately. But if every action errored
      // (nothing executed, page unchanged) clear lastHash to re-prompt now.
      const anyExecuted = observations.some(o => o.status === 'ok');
      const primaryExecuted = anyExecuted ? validActions.find(a => a.verb !== 'done') : null;
      // Actions flagged changesPage:false (e.g. select_text) never alter the
      // hashed view, so waiting for a change is pointless — clear lastHash to
      // re-prompt immediately instead of polling maxNoChangePolls for nothing.
      const changesPage = primaryExecuted ? actions[primaryExecuted.verb]?.changesPage !== false : false;
      lastHash = (anyExecuted && changesPage) ? brief.briefHash : null;
      // Track the executed action for the no-op guard (first non-done action),
      // plus its read key + page hash so the guard can catch idempotent reads
      // repeated on an unchanged page.
      lastActionKey = primaryExecuted ? actionKey(brief, primaryExecuted) : null;
      lastReadKey = primaryExecuted ? idempotentReadKey(brief, primaryExecuted) : null;
      lastActionBriefHash = primaryExecuted ? brief.briefHash : null;
      // If the primary (first non-done) action ERRORED, remember its stable key so
      // re-planning it next turn increments stuckStreak via sameErroredTarget. A
      // success or a different target leaves this null, resetting the streak — so a
      // legitimate dismiss-overlay-then-retry isn't mistaken for flailing.
      const primaryIdx = validActions.findIndex(a => a.verb !== 'done');
      const primaryErrored = primaryIdx >= 0 && observations[primaryIdx]?.status === 'error';
      lastErroredKey = primaryErrored ? actionKey(brief, validActions[primaryIdx]) : null;

      // Scroll-oscillation escape hatch. The model is scrolling back and forth on
      // one page (down→up→down…) without clicking, saving, or navigating — it's
      // lost, not reading. Give it a reflection turn to pivot. Unlike the stuck
      // guard, a scroll loop alone never aborts: if reflection is unavailable
      // (capped/cooldown/off) we keep emitting the warning and let the run go on.
      if (scrollEscalate) {
        const n = scrollLoopState.reversals;
        const hint = `You have scrolled back and forth on this page ${n} times (down then up then down…) without clicking, saving, or leaving. That is thrashing, not reading — the target is probably not on this page. Save anything useful with save_text, then go back or try a different source.`;
        if (await escalate('scroll-oscillation', brief, { hint }) === 'reflected') {
          scrollLoopState.reversals = 0; // pivot acknowledged; don't immediately re-fire
          iter--;                        // the reflection turn doesn't consume the step budget
          continue;
        }
      }
    }

    runArtifact.status = 'max-steps';
    return await finish(runArtifact, { scratchpad, config: cfg });
  } catch (err) {
    runArtifact.status = 'failed';
    runArtifact.error = err?.message || String(err);
    // Normalized provider taxonomy (see _shared.classifyHttp): auth, rate_limit,
    // server, timeout, network, … null for non-provider failures. Recorded on the
    // artifact and surfaced so an auth typo reads differently from a network blip.
    if (err?.type) {
      runArtifact.errorType = err.type;
      emit(`\nerror · ${err.type}${err.status ? ` (${err.status})` : ''}: ${err.message}`);
    }
    return await finish(runArtifact, { scratchpad, config: cfg });
  } finally {
    process.removeListener('SIGINT', onSigint);
    try { logger.finalize(runArtifact); } catch {}
    try { await exec.close(); } catch {}
  }
}

async function finish(runArtifact, { scratchpad, config = {} } = {}) {
  if (scratchpad) {
    const manifest = scratchpad.readManifest?.() || '';
    const reportCfg = config.models?.report || {};
    const rawTokens = estimateTokens(manifest);
    runArtifact.reportEvidence = {
      source: 'saved-manifest.json',
      rawTokens,
    };
    if (reportCfg.enabled === false) {
      runArtifact.report = fallbackReport(runArtifact, manifest, 'Final report synthesis disabled', { evidenceSource: 'saved-manifest.json' });
    } else {
      try {
        const { provider: reportProvider, model: reportModel } = resolveRole(config, 'report');
        const { text, completion } = await generateReport({
          task: runArtifact.task,
          context: config.context,
          plan: runArtifact.plan,
          status: runArtifact.status,
          result: runArtifact.result,
          error: runArtifact.error,
          evidence: manifest,
          evidenceSource: 'saved-manifest.json',
          evidenceMode: 'manifest',
          rawTokens,
          provider: reportProvider,
          model: reportModel,
          cacheKey: 'browser-agent:report',
          reasoningEffort: reportCfg.reasoningEffort,
          maxTokens: reportCfg.maxTokens,
          timeoutMs: reportCfg.timeoutMs,
        });
        if (completion) {
          runArtifact.completions.push(completion);
          runArtifact.stats.totalInputTokens += completion.usage?.inputTokens || 0;
          runArtifact.stats.totalOutputTokens += completion.usage?.outputTokens || 0;
        }
        runArtifact.report = text || fallbackReport(runArtifact, manifest, 'Final report model returned no text', { evidenceSource: 'saved-manifest.json' });
      } catch (err) {
        const reason = err?.message || String(err);
        runArtifact.report = fallbackReport(runArtifact, manifest, reason, { evidenceSource: 'saved-manifest.json' });
      }
    }
    scratchpad.writeReport?.(runArtifact.report, { title: runArtifact.task || 'Report' });
  }
  runArtifact.endedAt = new Date().toISOString();
  runArtifact.stats.totalElapsedMs = Date.parse(runArtifact.endedAt) - Date.parse(runArtifact.startedAt);
  const s = runArtifact.stats;
  const elapsed = (s.totalElapsedMs / 1000).toFixed(1);
  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const errNote = runArtifact.error ? `  error: ${runArtifact.error}` : '';
  console.error(`\nfinished · ${runArtifact.status} · ${s.stepCount} steps · ${elapsed}s · ${fmt(s.totalInputTokens)} in / ${fmt(s.totalOutputTokens)} out${errNote}`);
  return runArtifact;
}

module.exports = { run, scrollPatternSignal };
