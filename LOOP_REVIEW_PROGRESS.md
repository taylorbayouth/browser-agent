# Loop Review — Implementation Progress

Tracks work against `LOOP_REVIEW.md`. Updated as findings are addressed.

## Done

### Phase 1 — correctness & hardening
- **A1** — `validate()` exempts `done` from the `intent` requirement, so a terminal
  action without `intent` is accepted instead of silently dropping the run to
  `max-steps`. (`lib/validate.js`)
- **#5** — scratchpad writes wrapped in a warn-once `safeWrite()`; a transient
  `ENOSPC`/`EACCES` no longer unwinds a good run to `failed`. (`lib/scratchpad.js`)
- **#6** — handoff drops the always-`null` `plan` field and surfaces the real
  Step-0 products: `expandedTask`, `requirements`, `recordContract`, `recordCount`.
  (`agent.js`)
- **#4** — `deadLinks` cleared on confirmed navigation, so one transient dead
  click no longer demotes a repeating nav href for the rest of the run.
  (`lib/loop.js`)
- **#9** — budget reflection latches `budgetReflected` only after the reflection
  fires (no longer swallowed on a cooldown collision). (`lib/loop.js`)

### Phase 1 — quick wins
- CLI errors when `--task` and positional words are both passed (no more silent
  truncation). (`agent.js`)
- Handoff exposes `report.empty` so callers can distinguish a bare `done` from a
  substantive completion. (`agent.js`)
- Removed dead `bboxArrToObj` in `os.js` and the unreachable `done`-break in
  `execute.js`.
- `computeBriefHash` includes region `label`/`named` (and now description/
  referenceImage/sourceUrl) so in-place graphic swaps bust the hash.
  (`lib/reduce.js`)

### Test coverage locked before refactor (Step 3)
- Provider error on a tooled turn → `status:failed` + `errorType` + fallback report.
- `done` with no saves → `report.empty:true` in handoff.
- `deadLinks` cleared on navigation (link clickable again on the next page).
- `applyCapabilities` strips `reasoningEffort` / returns a new object (exported).
- `isConnectionError` truth table (exported).
- Logger: timestamped jsonl line, `latest.json` + `run-final`, warn-once on failure.
- `done` accepted without `intent`.

### Step 0 — record contract field loosening
- `recordContract.fields` split into `requiredFields` / `optionalFields`. The
  planner reasons about field availability; the model must have all required
  fields before `save_record`, optional ones are attempted but never block a save.
- `normalizeRecordContract` preserves the split (legacy flat `fields` → all
  required) and **clamps** `target` to `[1,100]` instead of discarding the whole
  contract on an out-of-range value.
- Progress block shows the split each turn:
  `Required: title, company | Optional (skip if not visible): salary`.
  (`lib/planning.js`, `lib/loop.js`)

### Elegant #1 — `stuckSignal()` extraction
- The four stuck shapes (`sameAction`, `repeatedRead`, `sameErroredTarget`,
  `sameTypeRepeat`) extracted into a pure, exported `stuckSignal()` returning
  `{ tripped, shape }`. Behavior-identical; `shape` now rides in the stuck log
  event. Nine per-shape table tests added. (`lib/loop.js`)

### Elegant #2 — `escalate()` directive + cooldown fix
- `escalate()` gained an `onReflected` callback that runs the instant a reflection
  fires, owning the reset-before-pivot contract (visitCounts, scroll reversals,
  budget latch) so the #9 bug class is structurally impossible.
- **#10** — reflection cooldown now clocked on the monotonic `totalIterations`
  rather than the refundable `iter`, so an intervening reflection no longer
  re-extends the cooldown and suppresses a reflection on a new stall.
  (`lib/loop.js`)

## Remaining

- **Elegant #3** — registry-driven display/persistence (collapse the
  `describeAction`/`termDesc` switches + the persistence `if`-chain onto the
  action registry). Ship display strings first, persistence second.
- **#12 / #30** — `flushAndExit()` + cooperative SIGINT shutdown. The naive
  "skip the report write on Ctrl-C" guard is unsound; needs a `finishing` flag
  that `finish()` observes plus a cooperative exit after `finish()` returns.
- **A3** — report framing for non-`completed` statuses ("this run did NOT
  complete…") so partial results aren't presented as finished deliverables.
- **#8** — turn-log diagnostic fields (`changed`, `briefHash`, `stuckStreak`,
  `revisits`, `pivotShown`; short-circuit poll counts).
- Smaller items: `runArtifact.records` storing full content (#low), reflection
  knob validation, `wait` range single-sourcing, remaining cleanup findings.

## Deferred (decision recorded)

- **Cycle detection / shared `actionHistory` buffer** — discussed as a fifth
  stuck shape for within-page A/B alternation. Deferred: the false-abort risk
  (a legitimate filter-toggle looks identical to a loop) isn't clearly worth it
  at default thresholds, and the review never raised it. Revisit with real run
  data. The `escalate()` directive already unified the *response* side, which is
  the half that delivers the "handle it in one place" goal at low risk.
