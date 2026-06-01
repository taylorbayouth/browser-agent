# Browser-Agent Loop Review

> Scope: the end-to-end loop from Step 0 → final `report.md`, reviewed against HEAD `b923bed` (the tree shifted twice during review — `0b97e40 "records no longer auto-stop"` landed mid-review; all line numbers and behavior below reflect current `main`).
>
> Method: a factual loop-map pass plus seven per-subsystem reviewers (loop orchestration, Step 0/prompts, execution/tools, perception/model, persistence/reporting, config/entry, testing/observability). **Every finding was adversarially re-checked against the code by a separate agent** that tried to refute it; 6 candidate findings were rejected as misreads and are listed at the end so you can see what was filtered. The fixes below incorporate the verifier's corrections — several reviewers proposed fixes that were themselves subtly wrong, and those are flagged.

---

## Executive Summary

The architecture is **fundamentally sound and does not need reshaping.** `run()` is a single orchestrator that owns all mutable state; everything else (`reduce`, `validate`, `execute`, `report`, providers) is a pure-ish function of its inputs, which is the right shape. Perception (`reduce`/`extract`), the action registry, and the provider facade have clean seams and genuinely good test coverage. One of the most tempting "elegant" rewrites — replacing the string event log with a typed event log and rewriting the loop as a reducer — was evaluated and **rejected as a non-fit**: the event log is model-facing prose, not a machine contract, and the report already consumes a stable on-disk IR (`saved.md` / `saved-index.md` / `runArtifact.records`). Don't build that.

The real issues cluster in three places: **(1) terminal-state correctness** — the loop can silently fail to complete or report misleading success; **(2) failure isolation** — a single disk or provider hiccup escalates into a whole-run failure; and **(3) the process boundary** — the JSON handoff is lossy and emits a permanently-`null` field.

**Top 3 highest-value fixes**
1. **A `done` action that omits `intent` is rejected by the validator, so the run never completes** (Finding A1). The validator forces `intent` on *every* verb, but `done`'s only declared arg is `result?`. A single missing field on the terminal action discards the entire run's success and it drifts to `max-steps`. Trivial fix, highest blast radius.
2. **Unguarded `fs` writes in the scratchpad turn a transient disk error into `status:'failed'`** (Finding #5). A run that already harvested dozens of records is reported as a total failure because one screenshot write hit `ENOSPC`. `log.js` already shows the warn-once pattern; the scratchpad just diverged from it.
3. **The stdout handoff is dead/lossy** (Finding #6): it emits `plan: runArtifact.plan ?? null` — a field never assigned anywhere — and omits the three actual products of a run (`expandedTask`, `requirements`, `recordContract`/`records`). The handoff is the entire machine contract with the caller.

**Top 3 risks**
1. **Silent misleading success.** `done` sets `status:'completed'` with no evidence check, so `ok:true` / exit 0 can ship with an empty/placeholder report (#22). Combined with A1's silent non-completion, the handoff's `ok` flag is the least trustworthy field.
2. **Run-wide state with no decay.** `deadLinks` is never cleared and is keyed by bare href, so one transient dead-click permanently demotes a repeating nav link for the rest of a 200-step run (#4).
3. **The SIGINT/`finish()` race.** Ctrl-C during the slow final synthesis overwrites the nearly-complete real report with a fallback — and the obvious fix is *unsound* (it would leave no report at all). Needs a cooperative-shutdown flag, not a naive guard (#12/#30).

The anti-flailing machinery (4 stuck shapes + scroll/revisit/budget guards + reflection) is the loop's most intricate and regression-prone region. It works, but it is under-tested at the predicate level and carries two small latent correctness bugs (#9, #10). The two highest-value *structural* improvements both target it: extract the stuck predicates into a pure, table-testable `stuckSignal()` (Elegant #1) and collapse the five copy-pasted `escalate→iter--→continue` sites into one directive (Elegant #2) — which also folds in the #9 budget-latch bug as a free side effect.

---

## Loop Map

Factual flow at HEAD `b923bed`. Entry → per-turn → termination.

**Entry points**
- CLI: `agent.js` `main()` (agent.js:174), guarded by `require.main === module` (agent.js:216). Also exports `buildHandoff`, `parseArgs`.
- Library: `run({session, task, config})` exported from `lib/loop.js:416` (plus `scrollPatternSignal`).
- `main()`: `parseArgs` → `deepMerge(loadConfig(), override)` → `validateConfig` → `preflight()` (launches Chrome, returns port 9222) → `connect()` (CDP `Session`) → `run()` → `process.stdout.write(JSON.stringify(buildHandoff(...)))` → `exitCode = status==='completed' ? 0 : 1`; `finally` closes the session.

**Pre-loop (inside `run()`)**
- `cfg = deepMerge(DEFAULTS, config)`; `exec = createExecutor(...)` (lib/execute.js); `runArtifact` built (loop.js:436) with `status:'running'`, `taskType/expandedTask/requirements/recordContract/records/steps/completions/stats`.
- `logger = createLogger` (writes `logs/latest.jsonl` streaming, `latest.json` on finalize); `scratchpad = createScratchpad` (`mkdir runs/<uuid>/`).
- SIGINT handler installed (loop.js:644); `exec.init()`; `waitUntilLoaded()` (cold-connect readiness).
- **Step 0** — `generatePlan()` (lib/planning.js): one LLM call, no tools, that rewrites the task and returns **`{ task (expanded), requirements[], taskType, recordContract }`**. Failure is caught and swallowed (run proceeds on the raw task). `effectiveTask = expandedTask || task`. `system = buildSystemPrompt(actions, cfg.context, effectiveTask, requirements)` (lib/prompt.js) — the immutable task + requirements ride inside the cached system prefix every turn.

**Per turn** (`while (iter < loopCfg.maxSteps)`, loop.js:756; `++totalIterations` ceiling at :760)
1. **Extract** — `nextChangedBrief()` (loop.js:307): `extractBrief` (followActiveTab + `waitUntilLoaded` + `session.extract` + `computeBriefHash`) then, if unchanged vs `lastHash`, poll up to `maxNoChangePolls`. `retrySparseNavigationBrief` re-extracts a sparse post-nav page.
2. Navigation event + `lastErroredKey` clear; **dead-link** detection (clicked link + still same URL → `deadLinks.add(href)`); **visit** accounting (`visitCounts`).
3. **Guard: url-revisit** (loop.js:823) → `escalate`. **Guard: budget** (loop.js:836, fires once at `maxSteps·budgetTurnFraction`) → `escalate`.
4. **Reduce** — `reduce(brief, cfg.view, deadLinks)` → `llmView.listing` (lib/reduce.js).
5. **Plan** — `buildTurnMessage(events, llmView, revisits, pendingPivot, recordProgressBlock)` → `callModel({system, tools, messages, cacheKey: runArtifact.id, ...})`. `turnActions = plannedActions.slice(0,1)`; extras rejected ("only one action per turn").
6. **Guard: stuck** (loop.js ~905-949) — 4 shapes (`sameAction`, `repeatedRead`, `sameErroredTarget`, `sameTypeRepeat`) → `stuckStreak`; `≥ maxStuckRepeats` → `escalate(onUnavailable:'abort')`.
7. **Validate** — `validate(turnActions, brief.lookup, actions)` (lib/validate.js); extras appended as ignored errors.
8. **Execute** — `exec.execute(validActions, session, brief)` (lib/execute.js → executors/os.js|cdp.js). `done`/`save_text`/`save_record`/`wait` are special-cased *before* the backend; `err.fatal` rethrows to end the run, other errors become `{status:'error'}`.
9. **Persist** — per observation: `scratchpad.saveImage/saveText/saveRecord/saveAsset`; base64/bulk content stripped, only summary/preview re-enters context; `savedRecordCount++` on `save_record`.
10. Log the turn (JSONL). **Guard: empty-plan** (`emptyPlanStreak ≥ maxEmptyPlans` → `escalate(abort)`).
11. **Record steps** — push `step` to `runArtifact.steps`; **`done` → `status:'completed'` + `finish()`** (loop.js:1081); build event lines; `scrollPatternSignal` → **Guard: scroll-oscillation** (`escalate(onUnavailable:'warn')`).
12. **Records have NO auto-stop** (loop.js:1152-1157): the contract only drives the progress block + `record N/target` notes; reaching the target never ends the run. The model must call `done`; `maxSteps` is the backstop.
13. Set `lastHash/lastActionKey/lastReadKey/lastActionBriefHash/lastClickedLink/lastErroredKey` for next turn's guards.

**State objects** (all closure vars in `run()` unless noted): `runArtifact` (the run record, returned + logged); `events[]` (model-facing prose memory); `lastHash` (short-circuit key); `visitCounts` (Map), `deadLinks` (Set), `lastClickedLink`; the no-op guard quartet `lastActionKey/lastReadKey/lastActionBriefHash/stuckStreak` + `lastErroredKey`; `emptyPlanStreak`; `scrollLoopState`; reflection state `reflectCount/lastReflectTurn/budgetReflected/pendingPivot`; `totalIterations` + `maxIterations` (absolute ceiling). External: `scratchpad` (owns `saved.md`/`saved-index.md`/`assets/`), `logger` (owns `logs/`).

**Report path** — `finish()` (loop.js:1243): `selectReportEvidence()` (saved.md if under `rawTokenBudget`, else saved-index.md) → `generateReport()` (LLM) or `fallbackReport()` → `scratchpad.writeReport()` writes `report.md` **and** `report.html` unconditionally.

**Termination paths** (status → routed through `finish()` except SIGINT): `completed` (done verb, loop.js:1082) · `stuck` (loop.js:949) · `empty-plan` (loop.js:1069) · `max-steps` (loop.js:1220 fallthrough) · `max-iterations` (loop.js:760) · `failed` (outer catch loop.js:1223, carries `errorType` from provider taxonomy) · `aborted` (SIGINT handler, writes fallback synchronously, `process.exit(130)` — **does not go through `finish()` or `buildHandoff`**).

---

## Findings

> Format: full detail for the high-value findings, condensed (but complete) for verified Low/Cleanup items. Severity reflects the *post-verification* level (`↓` = a reviewer's severity the verifier downgraded). Fixes are the corrected versions.

### [Medium] A `done` with no `intent` is rejected → the run never completes
- **Location:** `lib/validate.js:88-96`; `lib/loop.js:1081-1086`; `lib/actions.js:95-99`
- **Category:** Correctness / Hardening
- **Problem:** `validate()` forces `{ intent: 'string', ... }` onto every verb and rejects any action whose `intent` is missing/empty/over-20-words. `done` declares only `result: 'string?'`. A model output `{verb:'done', args:{result:'<final answer>'}}` with no `intent` lands in `errors`, never `validActions`; the completion path only runs over observations of `validActions`, so `status` is never set to `completed`. The run keeps looping (the rejected `done` becomes an event line) and drifts to `empty-plan`/`max-steps` even though the model finished and supplied the result. The system prompt and tool schema both push `intent`, so it usually *is* present — but a single omission on the terminal action silently discards the whole run.
- **Why it matters:** Highest-stakes action, highest blast radius: a successful task becomes `ok:false` / exit 1, and the remaining step budget is burned.
- **Recommended fix:** Exempt `done` from the intent check in `validate()`: `const argSchema = verb === 'done' ? (spec.args||{}) : { intent:'string', ...(spec.args||{}) };` and guard the `intent.trim()`/`wordCount` checks with `if (verb !== 'done')`. (Cleaner alternative that also kills the dead-envelope issue in #15: intercept `done` from `plannedActions` *before* validation in `loop.js`.)
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** `validate([{verb:'done',args:{result:'answer'}}],{},ACTIONS)` → `ok.length===1`; loop test: fake provider returns `done` with no intent on turn 2 → `status==='completed'`, `result==='answer'`.

### [Medium] A filesystem error in any `save_*` crashes the turn and marks a good run `failed`
- **Location:** `lib/scratchpad.js:106,125,150,174,187,217,228,251-252`; `lib/loop.js` persistence block + outer catch (`status='failed'`)
- **Category:** Hardening
- **Problem:** Every write in `scratchpad.js` (`appendIndex`, `saveText`, `saveRecord`, `saveImage`, `saveAsset`, `writeReport`) is a bare `fs.appendFileSync`/`writeFileSync` with no try/catch. These run inside the main loop body whose only handler is the outer catch that sets `status='failed'`. A transient `ENOSPC`/`EACCES`/`EROFS` on one screenshot or record write unwinds the whole loop and converts a run that already collected valid records into `failed` (exit 1). `log.js` deliberately wraps the same pattern (warn-once, continue); the scratchpad silently diverges.
- **Why it matters:** A single disk hiccup or read-only `assets/` masquerades as total failure and poisons the handoff `ok` flag.
- **Recommended fix:** Mirror `log.js`: add one warn-once `safeWrite(fn)` wrapper in `createScratchpad`, wrap all six write sites, return `null` on failure. Callers already treat the returned `{path,...}` as nullable (`saved?.path || null`). **Must include `writeReport`** (lines 250-252) or the persistent-fault crash path through `finish()` remains.
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** `chmod 0500` the assets dir mid-run, trigger `take_screenshot`, assert the run still ends with its real status and exactly one warning was emitted.

### [Medium] `deadLinks` is never cleared and is keyed by bare href → one transient dead click permanently demotes that URL run-wide  ↓(from High)
- **Location:** `lib/loop.js:517,797-798`; `lib/reduce.js:122-123`
- **Category:** Correctness
- **Problem:** `deadLinks` is allocated once per run and only ever grows (`deadLinks.add(href)`); no `delete`/`clear` exists. `reduce.formatInteractive` demotes *any* element whose `el.url` is in the set to a non-clickable line. A link can be marked dead for transient reasons (overlay intercepted the click, page mid-load, modal open), and that href is then demoted on the current page *and every future page* that exposes it — nav bars, footers, breadcrumbs, paginated "next"/"home" links that repeat hrefs.
- **Why it matters:** On a site whose primary nav repeats hrefs across pages, one false dead-click can strip the model's ability to click core navigation for the rest of a 200-step run, with no recovery path.
- **Recommended fix:** Bound the lifetime/key. Minimal: clear `deadLinks` on each confirmed navigation (the nav block at loop.js:782 — ordering-safe, since the nav block and the dead-link add are mutually exclusive within a turn). Stronger/better long-term: key by `${pageUrl}|${href}` (and compare `${brief.url}|${el.url}` in reduce) so a dead click is scoped to the page it failed on. Either preserves the same-page repeat-click protection this guard targets.
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Add href X to `deadLinks` on page A (simulated non-navigating click), navigate to page B which also has X as a working link → assert B renders X as a clickable `[@eN]` line, not `link (dead)`.

### [Medium] Dead/lossy handoff: `plan` is always `null`; Step-0 products and records never surface  ↓(from High)
- **Location:** `agent.js:145`; `lib/loop.js:447-448,715-724` (and the `records` pushes)
- **Category:** Correctness
- **Problem:** `buildHandoff` emits `plan: runArtifact.plan ?? null`, but `runArtifact.plan` **is never assigned anywhere** (verified by grep). The actual Step-0 products live on `runArtifact.expandedTask`, `runArtifact.requirements`, and `runArtifact.recordContract`; collected items live on `runArtifact.records`. None are mapped into the handoff. So the JSON the parent reads always reports `plan:null` and never exposes the rewritten task (the run's immutable north star), the requirements checklist, the contract, or how many records were collected.
- **Why it matters:** The handoff is the entire machine-readable contract across the process boundary. A structurally-always-`null` field misleads consumers; the most valuable run products are invisible to anything downstream.
- **Recommended fix:** In `buildHandoff`, drop `plan` (no internal consumer keys on it) and add `expandedTask: runArtifact.expandedTask ?? null`, `requirements: runArtifact.requirements ?? []`, `recordContract: runArtifact.recordContract ?? null`, and **`recordCount: (runArtifact.records||[]).length`** (a count, not the array — see A2; bodies are large and already on disk, whose paths are in the handoff).
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Run a records task to completion, parse stdout JSON, assert `expandedTask` non-null and `recordCount` reflects saves; assert no key is structurally always-null.

### [Medium] A truncated Step-0 JSON reply becomes the agent's literal instruction
- **Location:** `lib/planning.js:186-207`
- **Category:** Hardening
- **Problem:** When `JSON.parse` fails, the fallback slices first-`{`…last-`}` and reparses; if *that* also fails (the dominant real case: a reply truncated mid-object) it falls through to the non-JSON branch and treats the entire raw broken-JSON blob as the rewritten task (`task: task || text` → returns `text`). The agent then runs against a literal `{"task":"do x","taskType":"records"` as its north-star instruction. The expand role runs `reasoningEffort:'high'` with no `maxTokens` cap, so a model spending budget on reasoning and truncating the answer is realistic.
- **Why it matters:** Silent — there's no log distinguishing "fell back to raw text intentionally" from "JSON was garbage." The instruction becomes machine noise.
- **Recommended fix:** Guard the non-JSON branch: if parsing failed **and** `text.trimStart().startsWith('{')`, return `task:''` so `effectiveTask = expandedTask || task` cleanly falls back to the raw operator task, and emit a distinct `malformed plan JSON` warn/log so it's observable. Also fix line ~200 (`task: task || text`) to return `''` rather than the blob when a valid object has an empty/whitespace `task`.
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** `parsePlanResponse('{"task":"do x","taskType":"records"', {mode:'auto'})` (no closing brace) → `task:''` (loop falls back to raw task), not the JSON fragment.

### [Medium→Low] `finish()` makes a second doomed provider call when the run just failed on that provider
- **Location:** `lib/loop.js:1225-1235,1258-1290`; `lib/report.js:88-107`
- **Category:** Correctness / Performance
- **Problem:** When the loop dies on a provider error, the catch sets `status='failed'` then calls `finish()`, which unconditionally enters `generateReport` against the report role. In the common single-provider config the report role resolves to the same provider that just failed — a second doomed call costing up to `report.timeoutMs` and a guaranteed extra error before `fallbackReport`.
- **Why it matters:** On rate-limit/auth failures the agent burns the full report timeout to reproduce the exact fallback it would have produced for free, and risks compounding rate-limit penalties.
- **Recommended fix:** Skip synthesis only for **deterministic, non-retriable, provider-wide** failures: `if (status==='failed' && errorType==='auth' && resolveRole(config,'report').provider === <failed provider>)` → straight to `fallbackReport` with the error as the reason. **Do not** blanket-skip on `server`/`network`/`timeout` (the reviewer's "simpler heuristic") — those are retriable and the report uses a different model + longer timeout, so it can legitimately succeed.
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Stub `callModel` to reject with an auth error → `finish()` produces a fallback without a second `callModel` when `status==='failed' && errorType==='auth'`.

### [Medium→Low] `status:'completed'` can ship with zero saved evidence and a placeholder report
- **Location:** `lib/loop.js:1081-1086`; `lib/report.js:60,121`; `agent.js:138,210`
- **Category:** Correctness
- **Problem:** `done` sets `status='completed'` unconditionally. If the model emits `done` having saved nothing, `finish()` runs with empty evidence and `report.md` is `(nothing saved)` / `_(nothing saved)_`, yet the handoff reports `ok:true` and exit 0. An orchestrator can't distinguish substantive completion from a bare `done`.
- **Why it matters:** The strongest misleading-success signal for any consumer of `ok`.
- **Recommended fix:** Additive, non-overriding: in `finish()`, when `reportEvidence.rawTokens===0`, set `runArtifact.reportEvidence.empty=true` and surface `report.empty` in `buildHandoff`. Do **not** downgrade `completed` to a different status (that flips `ok`/exit and overrides the model's judgment — needs an explicit product decision).
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Loop whose first action is `done` with no saves → handoff exposes an evidence-empty signal rather than indistinguishable `ok:true`.

### [Low] Budget reflection is consumed even when it never fires (cooldown/cap collision)  ↓(from Medium)
- **Location:** `lib/loop.js:836-842`
- **Category:** Correctness
- **Problem:** The budget guard sets `budgetReflected = true` *before* knowing whether the reflection fired. If a stuck/revisit/scroll reflection fired within the last `cooldownTurns`, or the cap is hit, `maybeReflect` returns false and `escalate` returns `null` (budget's `onUnavailable` is `'warn'`, which emits nothing) — but `budgetReflected` is already latched, so the single budget checkpoint is permanently swallowed with no trace.
- **Why it matters:** The budget reflection is the only mid-run "is this approach still worth it?" check independent of flailing; losing it on a cooldown collision defeats it on exactly the long, churning runs where it matters.
- **Recommended fix:** Latch only on success: `if (!budgetReflected && iter >= budgetTurn) { const e = await escalate('budget', brief); if (e==='reflected') { budgetReflected = true; iter--; continue; } }`. The cooldown gate short-circuits before the LLM call, so re-entering each turn is cheap. (Folded for free into Elegant #2.)
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Force a stuck reflection at turn N, drive `iter` to `budgetTurn` within `cooldownTurns` of N → budget reflection retried after cooldown clears, not silently dropped.

### [Low] Reflection turns are double-counted against the cooldown, blocking legitimate new escalations  ↓(from Medium)
- **Location:** `lib/loop.js:564,592` + the five `iter--` sites
- **Category:** Correctness
- **Problem:** `maybeReflect` sets `lastReflectTurn = iter`, then callers do `iter--` to refund the step; next pass `iter++` restores `iter` to the value it had when the reflection fired. So the cooldown check `iter - lastReflectTurn < cooldownTurns` reads distance 0 on the very next turn, and you must burn `cooldownTurns` *real* steps before another reflection can fire — suppressing reflections on genuinely *new* stalls (a resolved stuck loop, then a scroll-oscillation 2 turns later) that each deserve one.
- **Why it matters:** Turns the escape hatches into single-shot mechanisms for ~4-turn windows, pushing runs toward hard aborts a second reflection could have prevented.
- **Recommended fix:** Clock the cooldown on `totalIterations` (which never rewinds): `lastReflectTurn = totalIterations` and gate on `totalIterations - lastReflectTurn < cooldownTurns`. Fully localized to two lines; no other reader of `lastReflectTurn` exists.
- **Complexity:** Low · **Risk:** Low→Medium
- **Suggested test:** Stuck reflection resolves, then induce scroll-oscillation within 3 turns → a second reflection (reason `scroll-oscillation`) fires (currently blocked).

### [Low] Turn JSONL omits the guard/diagnostic state needed to explain a loop or short-circuit
- **Location:** `lib/loop.js:1036-1050` (turn event), `:945` (stuck event), `:307-326` (nextChangedBrief)
- **Category:** Observability
- **Problem:** The per-turn log records `url/title/listing/planned/rejected/observations/usage` but not the loop-control state diagnosis hinges on: `changed`, `stuckStreak`, `briefHash`, `revisits`, whether a `pendingPivot` was injected, or how many short-circuit polls ran (`nextChangedBrief` consumes polls with no event). The stuck event logs `repeats` but not *which* of the four shapes tripped.
- **Why it matters:** `latest.jsonl` is the primary forensic artifact when a run loops/stalls; today an investigator sees *what* the model planned but not *why* the loop did or didn't intervene.
- **Recommended fix:** Add `changed`, `briefHash`, `stuckStreak`, `revisits`, `pivotShown` to the turn event (capture `pendingPivot` **before** it's nulled at loop.js:862), `shape` to the stuck event (free from Elegant #1), and have `nextChangedBrief` return `polls` so a `{kind:'short-circuit',turn,polls}` event can be emitted. No control-flow change.
- **Complexity:** Low · **Risk:** Low
- **Suggested test:** Stuck scenario with logging on → turn events carry `changed:false` and rising `stuckStreak`; stuck event carries `shape:'sameAction'`.

### [Low] `run()` failure path (provider error, `errorType` propagation) is untested
- **Location:** `lib/loop.js:1225-1235`; `test/agent.test.js` loopSuite
- **Category:** Testing
- **Problem:** The only terminal statuses exercised through `run()` are `completed`, `empty-plan`, `max-steps`, `stuck`. The catch block (`status='failed'`, `error`, `errorType` from the provider taxonomy) and the failure-path `finally` cleanup have zero coverage; the fake provider never throws.
- **Why it matters:** The failure path is what runs when a real run dies (auth typo, rate limit, network); a regression that dropped `errorType` or threw out of `finish()` cleanup would ship silently. Cheapest gap to close — the harness already exists.
- **Recommended fix:** Make the fake provider throw `{type:'rate_limit',status:429}` on a **tooled** turn (a no-tools throw hits reflect/report, which are independently caught). Assert `status==='failed'`, `errorType==='rate_limit'`, message preserved, and a fallback `report.md` was written. Second test: plain `Error` → `errorType` undefined, `status==='failed'`.
- **Complexity:** Low · **Risk:** Low

### Condensed verified findings (Low / Cleanup)

Each is real and confirmed against the code; fixes shown are the corrected versions.

- **[Low] Step-0 contract `target` is hard-rejected (not clamped) out of range, discarding the whole contract** — `lib/planning.js:154-155`. `target` of 200/101/5.5/"12 jobs" → `null`, throwing away `recordName` + `fields`. **Fix:** clamp — `let t = Math.round(Number(value.target)); if (!Number.isFinite(t)||t<1) t=1; if (t>100) t=100;` (preserves fields in all cases). The header comment claims a "clamp" that doesn't exist — reconcile. *Cx Low / Risk Low.*

- **[Low] Forced `mode=records` with a contractless/non-JSON Step-0 reply loses the progress block** — `lib/planning.js:196-207`; `lib/loop.js:720-726`. `taskType` is forced to `records` but `recordContract` stays `null`, so no progress block or `record N/target` notes appear. *(Note: with records auto-stop now removed, the original "never auto-stops" framing is moot — see Reconciliations. This is now a cosmetic/tracking loss, not a termination bug.)* **Fix:** synthesize a default contract when `taskType==='records' && !normalizedContract`. *Cx Low / Risk Low.*

- **[Low] `_currentUrlTitle()` silently substitutes the cached URL after a failed live read** — `lib/connect.js:172-189`. On a `Target.getTargetInfo` hiccup after a real navigation, the brief carries fresh elements but a stale URL; on pages whose listing matches the prior page this can collide `briefHash` → false "no change" short-circuit, and mis-keys every URL-derived guard. **Fix (verifier-corrected):** adopt only the *diagnostic* part — log the swallowed error at connect.js:187 and keep the last-known-good fallback. **Do not** propagate `null` (the reviewer's option b) — `performExtract` returns `url:null`, which breaks the dead-link/nav/revisit guards on every transient hiccup. *Cx Low / Risk Low.*

- **[Low] `computeBriefHash` drops region `label`/`named`, so an in-place graphic swap can false-no-change** — `lib/reduce.js:31-34`. The regions whitelist hashes only `role`, but `formatRegion` renders `label` and the `named` capture-vs-read note. **Fix:** `regions: brief.regions?.map(r => ({ role:r.role, named:r.named, label:r.label })) ?? []` (bbox still excluded — existing moved-region test still passes). *Cx Low / Risk Low.*

- **[Low] Dead-link detection false-positives on same-URL in-place content swaps** — `lib/loop.js:797-799`. Decided solely by `brief.url === fromUrl`, so a tab/filter/SPA control that re-renders without changing the URL is marked dead (and, per #4, demoted run-wide). **Fix:** require same URL **and** unchanged `briefHash` since the click (capture the click-time hash onto `lastClickedLink.fromHash`). Strictly narrows false positives. *Cx Low / Risk Low.*

- **[Low] CLI silently truncates an unquoted task after `-t`/`--task`** — `agent.js:50,60`. `node agent.js -t book a flight` runs the task `"book"`; trailing positionals are dropped because line 60 only joins them when `!args.task`. **Fix:** after the parse loop, `if (args.task && positional.length) usageError('pass the task once: --task "..." OR positional words, not both')`. *Cx Low / Risk Low.*

- **[Low] `--context`/`--model` can't accept a value beginning with `--`** — `agent.js:42-46`. `value()` rejects any next token starting with `--`, so `--context "--- trusted ---"` hard-exits. **Fix (verifier-corrected):** the reviewer's "accept any token for free-form flags" re-introduces the `--task --provider` swallow bug. Instead add `--context=VALUE` long-form assignment (fully additive), **or** reject the next token only when it's a *recognized* option name. *Cx Low / Risk Low.*

- **[Low] Reflection numeric knobs bypass validation and can silently disable guards** — `agent.js:117-126`; `lib/config.js:295`. `validateConfig` range-checks five `loop.*` ints but not `budgetTurnFraction`/`cooldownTurns`/`maxReflections`; `validateModels` only checks `Number.isFinite`. `budgetTurnFraction:6` makes the budget reflection never fire; a huge `cooldownTurns` permanently suppresses reflections. **Fix:** warn-only (matching `validateModels`) for `budgetTurnFraction ∉ (0,1]`, negative/non-integer `cooldownTurns`/`maxReflections`. Don't reject `0` (legitimate). Don't silently clamp. *Cx Low / Risk Low.*

- **[Low] `wait` range (0..30000) lives in three disconnected places** — `lib/execute.js:18,68-72`; `lib/actions.js:49-53`. Typed as `number` in the registry, range hard-coded in `execute.js`, restated as prose in the description; the validator passes a value the executor then rejects as a wasted turn. **Fix (verifier-corrected):** add an `argRanges` map or object-form arg schema — but note `checkArgs` currently assumes every schema value is a *string* (`type.endsWith('?')`), so an object form requires teaching `checkArgs` to accept both shapes. The parallel-map option is lower-risk. *Cx Low / Risk Low.*

- **[Low] Error taxonomy / capability-stripping / connection-classification are untested** — `lib/providers/_shared.js` (`classifyHttp`), `lib/model.js:56-65` (`applyCapabilities`), `lib/connect.js:46-57` (`isConnectionError`). These pure functions decide retry/reconnect/abort. **Fix (verifier-corrected):** `classifyHttp` is *already* covered at `test/agent.test.js:3043-3063` — skip it. Add a table test for `applyCapabilities` (strips `reasoningEffort` to null, returns a new object, original untouched) via `providers.fake` injection, and export + test `isConnectionError`. *Cx Low / Risk Low.*

- **[Low] `max-iterations` and SIGINT (`aborted`) terminal paths are untested** — `lib/loop.js:760-766,643-665`. **Fix:** extract `onSigint`'s body into an exported `flushAndExit(runArtifact, {exit=process.exit})` so it's unit-testable with a stub exit. For `max-iterations`, pin `loop.maxIterations` low explicitly and keep `maxReflections` high enough not to cap first (otherwise the run ends as `stuck`). *Cx Medium / Risk Low.*

- **[Low] `createLogger`'s enabled write path is untested** — `lib/log.js:30-45`; only the `enabled:false` case is covered. **Fix:** three tmpdir tests — `event()` appends a ts-stamped parseable line; `finalize()` writes `latest.json` and a trailing `run-final` jsonl line; a stubbed `appendFileSync` throw → exactly one stderr warning across two calls (warn-once latch). *Cx Low / Risk Low.*

- **[Low] Adding a verb touches 6+ sites; the registry is single-source for schema only, not behavior** — `lib/actions.js`; `lib/execute.js:49-86`; `lib/loop.js` `describeAction`/`termDesc`/persistence block. Two parallel `switch` statements + an `if`-chain encode verb knowledge a fourth/fifth time; a new verb silently renders as a bare token. **Fix:** see Elegant #3 (move display/persistence hints onto the registry). *Cx Medium / Risk Medium.*

- **[Cleanup] Dead `bboxArrToObj` in `os.js`; `nodeByRef`/bbox helpers triplicated** — `lib/executors/os.js:53-64`, `cdp.js:17-32`, `page.js:190-201`. **Fix:** delete the dead `bboxArrToObj` (unambiguously safe); export `nodeByRef` from `page.js` and import in os/cdp (behavior-identical). The bbox normalizer dedup needs a minor call-site edit (cdp passes the bbox; page's `bbox(node)` reads it internally) — not a pure swap. *Cx Low / Risk Low.*

- **[Cleanup] `done` builds an Observation in `execute.js` that the loop discards** — `lib/execute.js:49-54,126`; `lib/loop.js:1078-1086`. Two layers both encode "done is terminal." **Fix (verifier-corrected):** the reviewer's "intercept `done` before `exec.execute`" is **not** behavior-preserving — the done step is pushed to `runArtifact.steps` and `stepCount` is incremented *before* interception (surfaced in the handoff + stdout), and tests at `agent.test.js:787,1516,1531` assert the done observation/step exists. Keep the step push; only stop building the Observation. Best done jointly with A1's pre-validation interception. *Cx Medium / Risk Low.*

- **[Cleanup] Executor loops over an action array but the loop hard-caps to one action** — `lib/execute.js:120-129`; `lib/loop.js:875,955`. `validActions.length` is provably ≤1, so the `for` loop and the `if (verb==='done') break` are dead generality. **Fix:** keep the array signature (option value) but document the single-element invariant and delete the unreachable `done`-break. Keep the `observations[]` shape so the persistence loop and tests stay untouched. *Cx Low / Risk Low.*

### Additional findings surfaced by the completeness critic (not independently re-verified)

- **[Medium] (= Finding A1 above)** — promoted to the top.
- **[Low] `runArtifact.records` stores full record `content` and serializes it into `latest.json`, triplicating on-disk evidence with no consumer** — `lib/loop.js:1009-1015`; `log.js:37`. For an N-record run the bodies live in the array, `saved.md`, *and* a pretty-printed copy in `latest.json`, scaling with the heaviest task type, read by no one (report sources from `saved.md`; handoff omits records). **Fix:** push `{number,summary,url,savedPath}` (drop `content`). *Cx Low / Risk Low.*
- **[Low] `finish()` frames every terminal status as a finished deliverable** — `lib/report.js:8-41`. `REPORT_SYSTEM` opens "The browser run is complete" and "write a report that directly satisfies the task" for `failed`/`stuck`/`max-steps` runs too; the only signal is the `Run status:` line. **Fix:** in `buildReportMessage`, for non-`completed` statuses emit "This run did NOT complete (status: X). Report what was accomplished and what remains; do not present partial results as a finished deliverable." *Cx Low / Risk Low.*

---

## Elegant Opportunities

Ranked by value. (Note #7 is an explicit *don't-do-this*.)

**1. Pure stuck-signal layer — extract the four stuck predicates into a testable `stuckSignal()` reducer** *(Effort: Medium, fits)*
The anti-flailing machinery is the largest source of untestable closure mutation: four inline `const` predicates (`sameAction`/`repeatedRead`/`sameErroredTarget`/`sameTypeRepeat`) over ~7 closure vars, each with comment-heavy gating (`sameTypeRepeat` fires regardless of `changed`; `sameAction` requires `!changed`; `repeatedRead` keys on `briefHash`). Only `scrollPatternSignal` is extracted. **Proposed:** a pure `stuckSignal({changed, primary, primaryKey, primaryReadKey, lastActionKey, lastReadKey, lastErroredKey, lastActionBriefHash, briefHash}) → {tripped, shape}`, exported, mirroring `scrollPatternSignal`. `run()` collapses to `const sig = stuckSignal(...); stuckStreak = sig.tripped ? stuckStreak+1 : 0;`. **Why better:** the most regression-prone logic in the loop becomes table-testable per shape, `run()` sheds ~20 lines of dense boolean algebra, and `shape` falls out for free (closing the observability gap). **Adoption:** copy the predicates verbatim into the function (first-match-wins), replace the inline block, add `shape` to the stuck event, add per-shape table tests. Behavior-preserving — the inputs are identical. *Caveat: replicate each predicate's distinct `changed`-gating exactly; pass `briefHash` + both read keys, not just action keys.*

**2. Collapse the five `escalate→iter--→continue` sites into one directive** *(Effort: Low, fits)*
The refund/reset dance is hand-rolled at all five guards with non-uniform shapes; the per-guard counter reset (`visitCounts.set(curUrl,0)`, `scrollLoopState.reversals=0`, budget has none) is exactly what drifts. **Proposed:** give `escalate()` an `onReflected` callback that runs the reset the instant `maybeReflect` succeeds, and return `'reflected'|'aborted'|null`. **Why better:** one place owns the reset-before-pivot contract; folds in the #9 budget-latch bug (pass `onReflected: () => { budgetReflected = true; }`) and the #10 cooldown fix as structural side effects. **Adoption:** add the param, thread the three resets through it, delete the inline resets and the premature `budgetReflected=true`. *Verifier caveat: `continue` must stay at the call site (can't be issued from inside `escalate`), and the abort guards keep their `aborted → return finish()` branch — so this trims each site to ~one statement, not literally one; the "one statement" framing was overstated.*

**3. Move per-verb display + persistence onto the action registry** *(Effort: Medium, fits)*
`actions.js` claims "single source of truth" but display lives in two parallel `switch` statements (`describeAction`, `termDesc`) and persistence in a hardcoded `if`-chain — a new verb renders as a bare token and skips persistence. **Proposed:** add `label`/`pastTense` strings and a `persist: 'image'|'text'|'record'|'file'|null` hint to each entry; the display fns fall back to the registry, and the persistence block dispatches on `actions[verb].persist`. **Why better:** makes the registry actually single-source; drops the "where do I edit to add a verb" surface from 6 toward 3. **Adoption:** display first (pure strings, lowest risk), persistence second. *Verifier caveat: a flat string only cleanly replaces the ~5 trivial verbs; arg-interpolating verbs (`type`, `navigate`, `take_screenshot`) still need a per-verb `render(action,brief,obs)` — this shrinks the switches, it doesn't eliminate them.*

**4. Surface Step-0 products and records in the handoff; kill the dead `plan`** *(Effort: Low, fits)* — see Finding #6. One edit to `buildHandoff`; the data is already on `runArtifact`. Turns the handoff from "status + report blob" into a structured result a parent can branch on.

**5. Wrap scratchpad writes + skip the doomed report call** *(Effort: Low, fits)* — combines Findings #5 and #21. Two small local guards that match patterns already in the codebase (log.js's warn-once; the nullable saved-object contract). Independently shippable.

**6. Make termination explicit and testable; surface report provenance** *(Effort: Medium, fits)* — extract `flushAndExit()` (testable SIGINT), add the missing `failed`/`max-iterations`/`aborted` tests, add a `synthesized: true/false` provenance flag at each fallback site surfaced in the handoff, and the turn-log fields from #8.

**7. ASSESSED ADEQUATE — do NOT build a typed event log / report IR / state-machine rewrite** *(does not fit)*
The tempting move — replace the string `events[]` log and the `saved.md` prose the report re-reads with a typed IR, and rewrite `run()` as a reducer — **adds code for no gain.** The event lines are *not* scraped for control flow (all guards key off structured closure state — `briefHash`, `actionKey`, `visitCounts`); they're consumed only by the LLM as prose memory. The report already consumes a stable on-disk IR (`saved-index.md` + `runArtifact.records`). A reducer rewrite of the ~890-line `run()` would be a high-risk big-bang touching every guard at once; Elegant #1 and #2 capture the real testability/duplication wins incrementally. **Recommendation:** leave it, and add a comment that the event log is model-facing prose so a future contributor doesn't "upgrade" it and regress the prompt.

---

## Quick Wins

Low complexity, low risk, immediate reliability/clarity gains:
1. **Exempt `done` from the `intent` requirement** (A1) — a few lines in `validate.js`; prevents silent non-completion.
2. **Wrap scratchpad `fs` writes with warn-once** (#5) — copy the `log.js` pattern; one disk error no longer fails a good run.
3. **Fix the handoff** (#6): drop dead `plan`, add `expandedTask`/`requirements`/`recordContract`/`recordCount`.
4. **Clear `deadLinks` on navigation** (#4) — one line; stops permanent run-wide link demotion.
5. **Latch `budgetReflected` only on success** (#9) — reorder three lines.
6. **CLI guard for `-t` + trailing positionals** (#23) — one `if` after the parse loop; turns silent truncation into a clear error.
7. **Delete dead `bboxArrToObj` in `os.js`** (#29) and **the unreachable `done`-break in `execute.js`** (#16).
8. **Add region `label`/`named` to `computeBriefHash`** (#18) — one map expression.
9. **Surface `reportEvidence.empty` in the handoff** (#22) — additive; lets callers distinguish a bare `done`.
10. **Add the failure-path loop test** (#7) — the cheapest high-value coverage; the harness exists.

## Larger Refactors

Worth doing, but with care and an order:
- **`stuckSignal()` extraction (Elegant #1).** Do first among the structural changes — it's the foundation for the `shape` log field and per-predicate tests. Preserve behavior by copying the predicates verbatim and asserting parity through the existing loop tests before adding new ones.
- **`escalate()` directive + `onReflected` (Elegant #2).** Do after #1, since it touches the same guard region. It folds in #9 and (optionally) #10; land those bug fixes inside it rather than separately.
- **Registry-driven display/persistence (Elegant #3).** Largest surface; ship display strings first (pure, reversible), persistence second, and keep `render()` functions for the arg-interpolating verbs. Don't claim the switches are eliminated — they shrink.
- **`flushAndExit()` + cooperative SIGINT shutdown (#12/#30).** The naive "skip the report write on Ctrl-C" fix is **unsound** (it leaves no report at all, since `process.exit` kills the in-flight async synthesis). The correct shape is a `finishing`/`aborting` flag that `finish()` observes and a cooperative exit *after* `finish()` returns — bigger than it looks; scope it deliberately.

## Tests To Add

**Loop control**
- Fake provider throws `{type:'rate_limit',status:429}` on a tooled turn → `status:'failed'`, `errorType:'rate_limit'`, message preserved, fallback `report.md` written (#7).
- Reflection refunds steps until `totalIterations > maxIterations` (pin `maxIterations` low, `maxReflections` high) → `status:'max-iterations'` (#26).
- Stuck reflection resolves, scroll-oscillation within 3 turns → second reflection fires (#10).
- Budget reflection retried after a cooldown collision rather than silently dropped (#9).
- Per-shape `stuckSignal()` table tests once extracted (Elegant #1).

**Tool/browser execution**
- `validate([{verb:'done',args:{result:'x'}}])` → accepted (A1).
- `wait` out-of-range rejected at the validator with the same feedback path (#14).
- `applyCapabilities` strips `reasoningEffort`, returns a new object, leaves the original untouched (#20); `isConnectionError` true for `WebSocket`/`Session closed`/`ECONNRESET`, false otherwise.

**State persistence**
- Read-only assets dir mid-run → run ends with its real status + one warning, not `failed` (#5).
- `createLogger`: ts-stamped turn line; `latest.json` round-trips; trailing `run-final`; warn-once on injected write failure (#27).
- `region.label` change busts `briefHash` while a bbox-only move does not (#18).

**Failure handling**
- SIGINT during a slow `generateReport` → the synthesized report is preserved (or a single clean fallback); `finalize` runs once (#12) — via the extracted `flushAndExit` with a stub exit.
- Same-page content swap (URL stable, `briefHash` differs) → href NOT added to `deadLinks`; a true no-op click IS (#19).

**Final report generation**
- `done` with zero saves → handoff exposes evidence-empty rather than `ok:true` (#22).
- Provider auth failure → `finish()` produces a fallback without a second `callModel` (#21).
- `buildReportMessage({status:'stuck'})` contains a not-completed directive (A3).
- `buildHandoff` exposes `expandedTask`/`requirements`/`recordCount`; no key is structurally always-null (#6).

## Suggested Implementation Order

1. **Immediate correctness/hardening (Quick Wins 1-5):** A1 (`done` intent), #5 (scratchpad write isolation), #6 (handoff), #4 (deadLinks clear), #9 (budget latch). These are small, independent, and each closes a silent-failure path.
2. **Low-risk simplifications + CLI/observability (Quick Wins 6-10):** #23, #29, #16, #18, #22, plus the #8 turn-log fields.
3. **Add tests around current behavior:** the failure-path loop test (#7), logger tests (#27), `applyCapabilities`/`isConnectionError` (#20), `deadLinks` scoping (#4/#19). Lock behavior *before* refactoring.
4. **Refactor toward cleaner boundaries:** `stuckSignal()` (Elegant #1) → `escalate()` directive folding in #9/#10 (Elegant #2) → registry-driven display/persistence (Elegant #3). Each preserves behavior and is guarded by step 3's tests.
5. **Larger elegant work:** `flushAndExit()` + cooperative SIGINT shutdown (#12/#30), report provenance + the `failed`/`stuck`/`aborted` framing (A3) and tests (#26).

---

## Appendix — candidate findings rejected in adversarial verification

Listed for transparency (the review filtered these as misreads, not real issues):
1. *"max-iterations charges refunded reflection turns, shrinking the budget"* — mathematically impossible: every pass does `iter++` **and** `++totalIterations`; reflections add `iter--`, so they cost a `totalIterations` tick but refund the step exactly as intended.
2. *"buildSystemPrompt caching rationale is inaccurate"* — false premise; the comment says "providers can cache it as a shared prefix" (generic), not an Anthropic-breakpoint claim, and the ordering rationale is genuine.
3. *"save_text/save_record coerce missing content to empty strings"* — unreachable: the executor is only called with `validActions`, which `validate()` already requires `content`/`summary` for.
4. *"CDP `back` leaves the session attached to a closed target"* — misread of the recovery branch in `page.js`/`connect.js`.
5. *"buildHandoff conflates failed and aborted; aborted carries no error"* — `buildHandoff` is **never called on the aborted path** (SIGINT calls `process.exit(130)` directly).
6. *"selectReportEvidence blows the budget when no index exists"* — the premise about the budget interaction was wrong.

*Completeness reconciliations:* the SIGINT path does **not** double-call `logger.finalize` (the `process.exit` preempts the `finally`); only the report write races. And with the recent "records no longer auto-stop" change, the original "null contract disables auto-stop" framing is moot — the only loss is the progress block.
