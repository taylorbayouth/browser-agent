# Browser Agent — Engine Design

This document captures the architecture, contracts, and conventions for the broader Browser Agent engine: the pipeline that goes from a live Chrome tab through an LLM and back to dispatched browser actions. Browser Agent's existing extractor (`lib/extract.js`) is one stage in this pipeline; the rest of the engine is what's being built on top of it.

**Status.** This is a working design doc. Decisions here are settled unless explicitly marked deferred. The doc should be updated as the design evolves — it is the single source of truth for cross-module contracts.

---

## Goals

1. **Componentized pipeline.** Each stage is a pure function (or async equivalent) with typed inputs and outputs. Stages communicate via JSON-serializable artifacts. Any stage can be swapped, replayed, logged, cached, or moved to a separate process without touching the others.
2. **Speed as a design constraint.** Caching is not implemented yet, but every interface is shaped so caching can be added later as an additive change — never a refactor. Where a cache will eventually live is marked as a *seam*.
3. **Provider-agnostic LLM layer.** Anthropic, OpenAI, and Ollama are all first-class. The rest of the engine never imports a vendor SDK.
4. **Determinism wherever possible.** Reduced briefs, hashes, and serializations are deterministic so replay, cache, and eval workflows work without bespoke plumbing.

---

## Architecture

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Connect  │──▶│ Extract  │──▶│  Reduce  │──▶│   Plan   │──▶│ Validate │──▶│ Execute  │
│  (CDP)   │   │ (input)  │   │ (prompt) │   │  (LLM)   │   │ (refs)   │   │  (CDP)   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
                    ▲                                                            │
                    └────────── settle() + Observe (re-snapshot) ────────────────┘
```

| Stage | Input | Output | Module | Status |
|---|---|---|---|---|
| Connect | port, target hints | `Session` | [lib/connect.js](lib/connect.js) | exists |
| Extract | `Session`, opts | `Brief` | [lib/extract.js](lib/extract.js) | exists |
| Reduce | `Brief`, history | `LLMView` | `lib/reduce.js` | exists |
| Plan | `LLMView`, goal, tools | `Completion` (→ `Action[]`) | `lib/model.js` + `lib/providers/*` | exists |
| Validate | `Action[]`, `Brief.lookup` | checked `Action[]` or errors | `lib/validate.js` | exists |
| Execute | `Action[]`, `Session` | `Observation[]` | `lib/execute.js` + `lib/executors/*` | exists |
| Loop | task, session | `Run` | `lib/loop.js` | exists |

`lib/actions.js` (registry) and `lib/prompt.js` (system prompt + vocab generation) are shared modules used by multiple stages.

---

## Artifacts

Every artifact is a plain JSON object with `kind` and `version`. Safe to log, persist, diff, replay, or ship across a wire.

### Brief

The output of `extract.js`. Already implemented (`schemaVersion: "2.0"`). One addition: a content-derived `briefHash` field.

```jsonc
{
  "kind": "brief",
  "schemaVersion": "2.0",
  "briefHash": "<sha256 of deterministic content>",
  "url": "...", "title": "...", "timestamp": "...",
  "viewport": { "width": …, "height": …, "scrollX": …, "scrollY": … },
  "elements": [ { "ref": "@e1", "role": "button", "name": "...", "bbox": [...] }, … ],
  "text":     [ { "ref": "@t1", "role": "heading", "name": "...", "level": 2, … }, … ],
  "regions":  [ { "ref": "@r1", "role": "canvas", "bbox": [...], "inViewport": true }, … ],
  "lookup":   { "@e1": 1276, "@t1": 1419, "@r1": 1502 },
  "stats":    { … }
}
```

`briefHash` is computed over a canonical serialization: sorted refs and their resolved data, viewport, url, title. Timestamps, `elapsedMs`, and other ephemeral fields are excluded. Two semantically-identical pages produce the same hash.

#### The perception band (below-fold look-ahead)

When the loop extracts with `inViewportOnly`, the include/exclude filter is **not** the viewport — it is the *perception band*: the real viewport **plus one extra viewport-height of look-ahead below the fold** (`isInPerceptionBand` in `lib/extract.js`). `inViewport` stays the honest "actually on screen" flag; the band is only what governs membership in the brief.

The motive is one saved LLM turn. Without look-ahead, a target sitting just past the fold costs a full round-trip: the model can't see it, emits `scroll`, we re-extract and re-prompt, and only then does it act. Pulling one screen of below-fold content into the brief lets the model find that target on the first turn and act immediately.

Three properties keep this an addition, not a regression:

- **The viewport floor is never clipped.** The viewport is a strict subset of the band, so this can only *add* below-fold elements — it can never drop something the user can see. The `maxListingLines` cap in `reduce.js` is the pathological-page seatbelt; because it truncates in reading order it sheds the lowest (spill) lines first, leaving visible content protected.
- **The spill is one viewport-height, not a fixed element count.** A scroll reveals exactly one viewport-height of new content, so "one scroll of look-ahead" *is* one viewport-height by definition. An element-count cap can't express that — 60 elements is ~100px on a dense feed (saves no scroll) or thousands of px on a sparse page (overshoots). A height self-scales to the user's actual window (`viewport.height`, from the layout metrics).
- **The spill is downward-only.** The loop enters a page at the top and reads top-to-bottom, so useful look-ahead is what comes next (below), never above. The band extends the bottom edge by `viewport.height` and leaves the top edge at the viewport.

A spilled element is genuinely off-screen (`inViewport:false`), so the hit-test (`DOM.getNodeForLocation`) cannot verify it yet — it shows as `unknown` in the debug overlay, and the executor still scrolls it into view (`clickablePoint` → `scrollIntoViewIfNeeded`) before clicking. The band governs what the model is *offered*, not what is *verified*: perception looks one screen ahead, but clickability is still proven at action time against the real viewport.

**Unreadable regions** (`regions`) are the parts of the page the accessibility tree can't describe: a rendered `<canvas>`, an `<img>` with no `alt`, an `<svg>` with no accessible name, a URL-backed CSS `background-image` used as content, or a **cross-origin `<iframe>`**. Their content (chart, map, scanned text, CAPTCHA, embedded login form, profile photo) isn't text in our tree, so it never appears in `elements`/`text`. `extract.js` reads them straight from the DOMSnapshot — tag + attributes + layout/computed styles — and emits a region for each rendered graphic that has **no accessible name** and is **not nested in a link/button** (those are control icons, already represented by the control). CSS backgrounds are included only when they are rendered, URL-backed, non-tiny, non-repeating, and not on/inside a control. This is a deterministic structural fact, not a heuristic about whether content is "missing": we report that a nameless graphic is painted here, and the planner decides whether it matters.

The cross-origin iframe case uses the same report-the-fact principle. A cross-origin iframe is an out-of-process frame (OOPIF): its document runs in a different renderer, so it's absent from our single `captureSnapshot`, and its text/elements never reach the brief. We detect this structurally — DOMSnapshot's `nodes.contentDocumentIndex` points an `<iframe>` at its embedded document **only for same-process frames** (whose content we already extract); an `<iframe>` with no such index is cross-origin (or unloaded) and unreadable from the DOM. We surface it as an `iframe` region so the model can read it via a cropped screenshot — the composited capture already includes cross-origin pixels — without the full multi-target OOPIF stitching that per-element refs inside the frame would require. Only `<iframe>` is handled; legacy `<frame>`/`<frameset>` are out of scope.

Each region gets an `@r` ref and a `lookup` entry (like `@e`/`@t`), and renders in the LLMView as an `[@rN]` line in reading order. The ref is accepted by `take_screenshot` for read-only inspection and by `save_image` for report promotion; `click`/`type`/`selectText` reject `@r` at validation. When `take_screenshot` is given any ref (`@e`/`@t`/`@r`, all optional), the executor resolves it to that node's bbox and passes a `clip` to `Page.captureScreenshot` with `captureBeyondViewport:true`, so the capture is cropped to the element's DOM rectangle — exactly, with no model-supplied coordinates, even if the element is scrolled off-screen. With no ref, it captures the full viewport as before (fully backward-compatible). An unresolvable ref degrades to a full-viewport capture rather than failing. Region *presence* (role only, not bbox) is included in `briefHash`, so a page gaining or losing a graphic re-prompts.

The capture encoding (`config.screenshot`) is tiered on this same ref/crop distinction. The vision model downscales internally, so a lossless PNG wastes bytes, image tokens, and disk. A full-viewport *describe* (no ref) tolerates heavy JPEG compression (`quality`, default 55); a cropped *read* (ref present — usually small text, chart labels, or a CAPTCHA) is effectively OCR where artifacts eat thin glyphs, so it uses a higher `croppedQuality` (default 92). The chosen mime/ext rides back on the observation so the saved artifact matches the bytes.

### LLMView

What actually goes into the prompt. No `lookup` (executor-only). Deterministic ordering.

```jsonc
{
  "kind": "llm-view",
  "version": "1.0",
  "briefHash": "<refers back to source Brief>",
  "url": "https://example.com/page",
  "title": "Page title",
  "viewport": { "width": …, "height": …, "scrollY": …, "contentHeight": … },
  "listing": "[@t1]  heading  \"Sign in\"\n[@t2]  label  \"Email\"\n[@e1]  textbox  \"Email\"\n[@r1]  image  640×320 — unreadable; take_screenshot @r1 to read\n…"
}
```

The `listing` is a compact, fixed-width-ish text format optimized for LLM tokenization and grep-ability. Refs are bracketed (`[@e1]`) to keep them visually distinct from content.

`reduce(brief, view)` builds it (config block `view`, see Configuration):

- **Interleaved by reading order.** Interactive elements (`[@e]`) and text nodes (`[@t]`) are merged into one list sorted top-to-bottom, left-to-right (rows banded by ~10px, then by x), so a label sits next to the field it describes. `@t` lines are primarily read-only grounding, but can be a `click` or `selectText` target (e.g. clickable text inside a container); the validator still rejects them for `type`.
- **Unreadable refs (`[@r]`).** DOM-opaque visual regions are shown with their role and size. The planner can inspect one with `take_screenshot @r` or persist it with `save_image @r` when the visual itself belongs in the report.
- **`view.includeText`** (default true) — interleave text nodes at all.
- **`view.maxTextChars`** (default 200) — truncate long text-node names.
- **`view.dedupeText`** (default true) — collapse *consecutive* identical text nodes (reset by any element), so adjacent AX duplication is removed but spatially-separated repeats — e.g. per-row prices — are kept.

Bboxes are used internally for reading order, clicking, and cropped screenshots, but they are not shown in the LLM listing and are not hashed.

### Action

One verb the LLM wants executed.

```jsonc
{
  "kind": "action",
  "verb": "type",
  "ref": "@e3",                  // omitted for ref-less verbs
  "args": { "text": "hello" }
}
```

### Completion

What a provider returned. First-class artifact — captures raw provider output for debugging, replay, and eval workflows.

```jsonc
{
  "kind": "completion",
  "version": "1.0",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "briefHash": "...",
  "raw": { /* provider's native response, unmodified */ },
  "actions": [ /* parsed Action[] */ ],
  "usage": {
    "inputTokens": …, "outputTokens": …,
    "cacheCreationTokens": …, "cacheReadTokens": …
  },
  "elapsedMs": …
}
```

Loop persists every Completion as part of the Run.

### Observation

Outcome of one executed Action.

```jsonc
{
  "kind": "observation",
  "verb": "click",
  "ref": "@e3",
  "status": "ok",                // "ok" | "error"
  "error": null,                  // string when status === "error"
  "elapsedMs": 42,
  "settleMs": 180                 // ms spent settling after dispatch
}
```

### Step

One paired (Action, Observation). Forms the canonical history unit.

```jsonc
{ "kind": "step", "action": { … }, "observation": { … } }
```

### Run

The top-level artifact. Loop builds this incrementally and emits it on exit. This is the persistable / replayable unit.

```jsonc
{
  "kind": "run",
  "version": "1.0",
  "id": "<uuid>",
  "task": "<the original goal>",
  "model": "claude-opus-4-7",
  "startedAt": "...", "endedAt": "...",
  "status": "completed" | "failed" | "max-steps" | "max-iterations" | "stuck" | "empty-plan" | "aborted",
  "result": "...",                // from `done` action if status=completed
  "steps":       [ /* Step[] */ ],
  "completions": [ /* Completion[] */ ],
  "briefs":      [ /* Brief[] in temporal order, optional */ ],
  "stats": {
    "stepCount": …, "totalElapsedMs": …,
    "totalInputTokens": …, "totalOutputTokens": …,
    "totalEstimatedPromptTokens": …
  }
}
```

Briefs are large; including them is optional and controlled by a verbosity flag on Loop. By default Loop keeps only the most recent Brief in memory and discards earlier ones.

---

## Action registry (`lib/actions.js`)

The single source of truth for every verb. Validator, Executor, and Prompt all read from this registry.

```js
module.exports = {
  click:    { requiresRef: true,  refType: ['e', 't'],  args: {} },
  focus:    { requiresRef: true,  refType: ['e'],       args: {} },
  type:     { requiresRef: true,  refType: ['e'],       args: { text: 'string', clear: 'boolean?' } },
  press:    { requiresRef: false,                       args: { key: 'string' } },
  selectText:{ requiresRef: true,  refType: ['e', 't'],  args: {} },
  scroll:   { requiresRef: false,                       args: { direction: 'string', amount: 'number?' } },
  navigate: { requiresRef: false,                       args: { url: 'string' } },
  wait:     { requiresRef: false,                       args: { ms: 'number' } },
  done:     { requiresRef: false,                       args: { result: 'string?' } },
};
```

Rules:

- `refType` is always an array, even when it contains only `['e']`. Adding a verb that targets `@t` later is non-breaking.
- `args` declares argument names and types as compact strings. Trailing `?` means optional. The validator interprets this — no separate schema file.
- Adding a verb is one entry. The system prompt's vocab section, the validator's argument check, and the executor's dispatch table are all derived from this registry.

### Verb contracts

| Verb | Effect | Notes |
|---|---|---|
| `click` | Mouse click at the resolved element's hit-region | Aims at the element's real hit polygon (`DOM.getContentQuads`), clamped to the visible viewport, instead of the raw bbox center — robust to large containers and multi-line links. Falls back to the bbox center if quads are unavailable. Before pressing, `DOM.getNodeForLocation` verifies the aim point isn't covered by an unrelated overlay (modal, cookie wall); if it is, the click is refused with a non-fatal error so the loop can dismiss it. Fails open if verification can't run. |
| `focus` | Focus the element | Useful before `type` on inputs that need explicit focus. |
| `type` | Type the literal string into the element | Focuses first, then dispatches per-character input. Replaces the field's existing value by default (focus → select-all → type); pass `clear:false` to append. Clearing is gated to text-input roles, so a stray `clear` on a non-text element can't trigger a page-wide select-all. |
| `press` | Send a single key (Enter, Tab, Escape, ArrowDown, …) | Top-level — does not target a ref. Useful for form submission. |
| `selectText` | Highlight a node's full text | Targets `@e` or `@t`. Click-drag from the node's top-left to bottom-right corner (selects whole node, not a sub-phrase). |
| `scroll` | Scroll the page | `direction: "up"|"down"`, optional `amount` in CSS pixels (default: one viewport). |
| `navigate` | Load a new URL | Causes a full re-snapshot; refs from prior briefs are invalidated. |
| `take_screenshot` | Capture the viewport and have a vision model describe it | Top-level, `changesPage:false`, `idempotentRead`. For visual content the text listing can't convey (image CAPTCHAs, charts, canvas) or screenshot inspection tasks. Optional `hint` focuses the description. Backend-agnostic (CDP `Page.captureScreenshot`). The image bytes are stripped after vision; use `save_image` when the visual itself belongs in report assets. See `lib/vision.js` + `vision` config. |
| `get_files` | List downloadable file links (PDFs, docs, archives) | Top-level, `changesPage:false`, `idempotentRead`. Scans `<a href>`/`<embed>`/`<object>`/`<iframe>` whose target looks like a file (extension or `download` attr), using DevTools DOM reads only — no page JS. |
| `save_text` | Save model-authored text to the run | Top-level, `changesPage:false`. Loop-level (special-cased in `execute.js`, no backend, no extra LLM call). Cleaned `content` is stored in `runs/<id>/saved-manifest.json`; only the model's `summary` re-enters the event log. |
| `save_file` | Download the bytes at a URL and save them | Top-level, `changesPage:false`. URL typically from `get_files` or a visible link. Download is no-page-JS: `data:` decode → `Page.getResourceContent` (cached, exact, no CSP) → `Network.loadNetworkResource` (cold, CSP-limited). Image → vision summary; else metadata. Bytes → `assets/`; summary re-enters the event log. See `lib/savefile.js`. |
| `save_image` | Promote a visual into report assets | Top-level, `changesPage:false`. With URL-backed `@r` regions, first tries to persist the original loaded image bytes via the same CDP resource path as `save_file`; if unavailable, falls back to a fresh crop/viewport capture (`@e`/`@t`/`@r`/no ref). No extra vision call. Writes to `assets/` and records image metadata in `saved-manifest.json`. |
| `save_record` | Group saved evidence into one completed record | Top-level, `changesPage:false`. Loop-level grouping op. All currently unassigned saved text/files/images move under one manifest `records[]` entry with compact model-provided metadata. No record id is stored in the MVP; unassigned saves remain useful evidence for the report. |
| `wait` | Sleep for `ms` milliseconds | For *deliberate* pauses only; `ms` is capped at 30000. Universal settle still runs after every verb — `wait` is not the settle mechanism. |
| `done` | Signal task completion | Loop captures the optional `result` string and exits with status `completed`. |

### `done` semantics

The LLM marks task completion by emitting `{ verb: "done", args: { result: "…" } }`. Loop captures the result and exits without re-snapshotting. `done` does *not* count toward step budget exhaustion (it always terminates cleanly).

### Final report

At finish, the loop reads `runs/<id>/saved-manifest.json`. It hands that manifest, the original task, optional trusted `context`, and the run's **plan of action** (see *Step 0*) to one no-tools report model call — the plan lets the report honor the intended deliverable shape and flag anything the plan called for that the evidence is missing. That model writes `report.md` for the original task, so organization can vary with the assignment instead of being locked to a code template. The prompt tells it to think through the best layout for this specific task and evidence, preserve source URLs and relative `assets/<file_name>` links, use both completed `records[]` and `unassigned[]` saves, call out gaps instead of inventing missing facts, and avoid omitting saved images/files/text.

If `report.enabled` is `false`, the report model is unavailable, or it returns no text, the loop writes a compact deterministic fallback report from the same manifest. The same Markdown is also rendered to `report.html` with `markdown-it` plus a thin page wrapper for link targets, overflow-safe URLs, and optional report framing CSS.

---

## Executor backends

`lib/execute.js` is a thin dispatcher. The actual input mechanics live in pluggable backends under `lib/executors/`:

| Backend | Module | Mechanism | Use case |
|---|---|---|---|
| `cdp` | `lib/executors/cdp.js` | `Input.dispatchMouseEvent` / `Input.insertText` via CDP | CI, headless tests, dev iteration |
| `os`  | `lib/executors/os.js`  | OS-level input via the `browser-input` helper — `CGEventPost` (macOS) / XTEST (Linux X11) | Production / stealth runs (macOS, Linux X11) |

Backends are selected per Run via the `executor` option on `loop.run()` (or via the `BROWSER_AGENT_EXECUTOR` env var). The default is `os`; tests and CI can opt into `cdp` for deterministic synthetic input.

### Why two backends

CDP input is convenient (zero dependencies, works headless, works on Linux) but synthesized: it never traverses the HID layer, motion is teleported, and timing is uniformly tight. Modern bot-detection vendors fingerprint that even when no script is injected.

OS-level input via `CGEventPost` goes through the same kernel pipeline as a real mouse/keyboard, so in-page JS sees `isTrusted: true` events with real timing and (when humanize is on) Bezier motion. This is the path designed to avoid bot detection.

### Backend interface

```js
{
  name: 'cdp' | 'os',
  async init() {},                          // boot resources (e.g., spawn helper)
  async close() {},                         // tear them down
  async click({ session, brief, ref }) {},  // one handler per verb in actions.js
  async type({ session, brief, ref, text, clear }) {},
  // … one handler per non-terminal verb …
}
```

`execute.js` owns the Observation envelope (status, error, elapsedMs, settleMs) and calls `session.settle()` after every non-`done` action. Backends only do dispatch.

### Coordinate translation (os backend)

The brief's bboxes are in CSS page coordinates relative to the document. CGEvent wants screen coordinates. The fallback translation is:

```
screen.x = window.left + chromeOffsetX + (pageX - scrollX)
screen.y = window.top  + chromeOffsetY + (pageY - scrollY)
```

- `window.{left,top,width,height}` — from `Browser.getWindowBounds`.
- `scrollX`, `scrollY` — from `Page.getLayoutMetrics().cssLayoutViewport.{pageX,pageY}`.
- `chromeOffsetY` — Chrome's title + tab + URL bar height. Computed as `windowBounds.height - cssVisualViewport.clientHeight`.
- `chromeOffsetX` — usually 0; computed analogously for completeness.

On macOS, `pageToScreen` first asks the native helper for the frontmost Chrome `AXWebArea` frame and uses that top-left as the viewport origin. That avoids inferring toolbar height when Accessibility exposes the real content rect. If the helper is old, AX is unavailable, or Chrome exposes no web area, the CDP-derived formula above remains the fallback.

`window`/scroll/offset are all resolved per-dispatch against the session's **current** target (`Browser.getWindowForTarget(targetId)`), so after the session follows a popup or new tab (see below) the math automatically tracks that window. Because CGEvents land on whichever window is topmost at the screen point, coordinate conversion (`pageToScreen`) calls `Page.bringToFront()` on the current target before each dispatch — so a followed popup is raised above any window behind it before the click lands. (The input safety gate `ensureInputSafe` can't do this: it holds only the browser-input helper, which has no CDP `Page` domain.)

### Tab following (multi-tab / popups)

A click that opens a new tab or popup leaves the CDP session pinned to the original tab. `Session.followActiveTab` (run before each snapshot) re-pins to where the action landed, reading CDP's target graph rather than guessing from OS window focus. The pure policy `chooseTab` decides: follow a child our tab opened (`openerId` — `window.open` tabs always keep it, since the child may need to communicate back to its opener); else a brand-new target that appeared since the last poll; and when our tab closes, return to its opener if still around, else the newest page. Deterministic and cross-platform.

**`back()` and new tabs:** a tab opened by the browser (`target=_blank`) starts with no history. When `back()` is called with no history and other page tabs are open, the current tab is closed and `followActiveTab` re-pins the session to the opener or newest remaining tab — the same recovery the session would do naturally when a tab closes. `back()` only throws (non-fatal) when the tab has no history *and* is the only tab open.

Per-element interaction *inside* a cross-origin (OOPIF) tab still needs multi-target stitching and is out of scope.

This avoids a hand-tuned constant for Chrome's chrome — the offset is recomputed every dispatch, so it's robust to user toggling the bookmarks bar or zoom.

### Humanize config

Off by default for `cdp`, on by default for `os`. All knobs flow through `executor.humanize` on the Run config:

```js
{
  executor: {
    backend: 'os',
    humanize: {
      enabled: true,
      mouseSpeedPxPerSec: 1400,
      mouseJitterPx: 2,
      keystrokeDelayMsMin: 25,
      keystrokeDelayMsMax: 85,
      preClickPauseMsMin: 40,
      preClickPauseMsMax: 160,
    }
  }
}
```

Mouse motion is a cubic Bezier from current cursor position to target with a small random sway on the control points (~10% of distance) and per-frame jitter. Travel time is `distance / mouseSpeedPxPerSec` at 60Hz. Keystrokes wait a uniform-random delay in `[keystrokeDelayMsMin, keystrokeDelayMsMax]` between characters. A `preClickPause` lands after arrival, before button-down — mimicking the human pause between "I'm here" and "I'm clicking".

---

## Configuration

All tunable knobs live in `browser-agent.config.json` at the repo root, loaded by `lib/config.js`. Resolution order, lowest to highest priority:

```
DEFAULTS (lib/config.js)  <  browser-agent.config.json  <  env vars  <  CLI flags
```

`loadConfig()` returns the merged DEFAULTS+file+env config; `agent.js` layers CLI flags on top via `deepMerge` and passes the final object as `run({ config })`. `deepMerge` skips `undefined`, so a partial override (one CLI flag, a half-populated file) never wipes sibling defaults. Library callers can pass a partial `config` to `run()` — it's merged over DEFAULTS internally.

| Key | Default | Meaning |
|---|---|---|
| `provider` | `openai` | LLM provider (also `BROWSER_AGENT_PROVIDER`). |
| `model` | `null` | `null` → provider's own default. |
| `context` | `null` | Optional trusted background (user info, prefs) appended to the system prompt (also `BROWSER_AGENT_CONTEXT`, `--context`/`-c`). `null` → no Context section. |
| `plan.enabled` | `true` | Run one upfront *Step 0* call that writes a short plan of action, threaded into the planner, reflection, and report (see *Loop semantics § Step 0*). |
| `plan.provider` | `openai` | Provider for the Step-0 planning call. Independent of the planner. |
| `plan.model` | `gpt-5.5` | Model for the Step-0 planning call (a stronger model to think before acting). |
| `loop.maxSteps` | `30` | Hard cap on LLM turns. |
| `loop.shortCircuitOnNoChange` | `true` | Skip the LLM call while the page is byte-identical (see below). |
| `loop.pollMs` | `1500` | Wait between re-checks while the page is unchanged. |
| `loop.maxNoChangePolls` | `10` | Give up waiting after this many polls and let the model act/finish. |
| `loop.maxStuckRepeats` | `2` | Stop after the same ineffective/errored/idempotent read action repeats this many times. |
| `loop.maxEmptyPlans` | `3` | Stop after this many consecutive LLM turns with no actions. |
| `loop.maxSparsePageRetries` | `4` | After URL change, retry sparse snapshots this many times before prompting. |
| `loop.sparsePageRetryMs` | `400` | Wait between sparse post-navigation re-extracts. |
| `loop.sparsePageMinNodes` | `2` | Elements + text + regions below this count is considered sparse. |
| `loop.maxSameDirectionScrolls` | `3` | Add a pivot warning after this many consecutive same-direction scrolls on one page. |
| `settle.afterActionMs` | `150` | Pause after an action before the next snapshot. |
| `settle.maxMs` | `2000` | Hard cap on settle. |
| `executor.backend` | `os` | `os` or `cdp` (also `BROWSER_AGENT_EXECUTOR`). |
| `executor.pauseOnUserInput` | `true` | OS backend: pause input while the human uses the mouse/keyboard, auto-resume when idle. |
| `executor.userIdleMs` | `600` | OS backend: how long the human must be idle before input resumes. |
| `executor.raiseChromeOnStart` | `true` | OS backend: preflight foregrounds the agent's Chrome (PID-targeted) so the frontmost-gate is satisfied without manual clicking. |
| `executor.humanize.*` | — | OS-backend motion/timing knobs (see Executor backends). |
| `vision.provider` | `openai` | Vision model provider for the image-summary path (`take_screenshot` and `save_file` on images) — `openai`/`anthropic`/`gemini`/`ollama`. Independent of the planner `provider`. |
| `vision.model` | `null` | `null` → a multimodal default for the chosen provider. |
| `vision.prompt` | `"Describe what you see…"` | Static base prompt sent with the image; a per-call `hint` is appended. |
| `vision.maxTokens` | `1024` | Output cap for the vision call. |
| `report.enabled` | `true` | Run one final no-tools LLM call that turns saved evidence into task-specific `report.md`. |
| `report.provider` | `openai` | Provider for final report synthesis. |
| `report.model` | `gpt-5.5` | Model for final report synthesis. |
| `log.enabled` | `true` | Write per-run JSONL and latest run artifacts. |
| `log.dir` | `logs` | Directory for run logs, resolved relative to the current working directory. |

**Model roles and inheritance.** There are five model roles — `plan` (*Step 0*), `primary` (the planner), `vision`, `reflect`, and `report` — each with its own `provider`, `model`, and per-request `timeoutMs`. `primary` is the base; every other role inherits `provider`/`model` from it wherever it leaves them unset, so a config that fills in only `primary` still drives all five. The inheritance rule lives in one place — `resolveRole(cfg, role)` in `lib/config.js` — which every call site (plan/reflect/report and the startup banner) goes through, so the roles can't drift apart. `loadConfig()` also runs a non-fatal `validateModels()` pass over the file's `models` block: an unknown role name (`reflct:`), a misplaced or misspelled field, or an obviously-wrong value type each draws a one-line stderr warning rather than being silently folded into DEFAULTS and disabling a role by accident.

---

## CLI output contract

`node agent.js` is designed for another process to call. Progress, preflight guidance, and turn status are written to stderr. Stdout is exactly one compact JSON object with `ok`, `status`, `runId`, `task`, optional trusted `context`, the run's `plan` of action (or `null`), `result`, final report content, and absolute paths to `report.md`, `report.html`, `saved-manifest.json`, `assets/`, and the run logs. Callers should parse stdout and use the paths directly instead of reconstructing run locations from cwd.

Exit codes are: `0` for `completed`, `1` for a run that executed but ended incomplete/failed, and `2` for usage/config/preflight errors.

---

## No-change short-circuit

Each turn, before spending an LLM call, the loop compares the new brief's `briefHash` against the hash of the page the model last acted on. If they match, the page hasn't changed — re-prompting with identical input would yield the identical action — so the loop **polls every `loop.pollMs` instead of calling the LLM**, until either the page changes (proceed immediately) or `loop.maxNoChangePolls` is exhausted (proceed anyway, so a genuinely static page lets the model try something else or finish). This is the "wait for the page to actually change" behavior, content-driven rather than timer-driven.

Two correctness details:

- **`briefHash` excludes ephemeral data.** `computeBriefHash` (in `reduce.js`) is a whitelist over `url`, `title`, `viewport`, and per-element/text *content* — `timestamp`, `elapsedMs`, `stats`, and `bbox` are never included. Without this, every snapshot would hash uniquely and the short-circuit would never fire. `bbox` is excluded deliberately: the LLM's listing carries no coordinates, so two layouts with identical elements are identical to the model.
- **No-op actions don't deadlock.** After a validation failure (nothing executed) the loop clears `lastHash` so the next turn re-prompts immediately rather than polling for a change that can't come. A genuine no-op action (focus, a checkbox that only mutates internal state) hits `maxNoChangePolls` and proceeds; total turns are still bounded by `maxSteps`.

---

## Settle contract

The biggest hidden risk in any browser-agent loop is snapshotting mid-transition: a click fires, the DOM mutates, async work runs, and a brief taken immediately after captures a half-rendered page. The LLM gets garbage on the next turn.

**Decision: settle is mandatory infrastructure, not an LLM responsibility.** Settle is a small post-action pause (`settle.afterActionMs`); the "wait until the page actually changes" work is done by the no-change short-circuit above, which polls at `loop.pollMs`.

### Implementation

`session.settle(opts)` is a primitive on the Session object. Current implementation: a fixed pause of `settle.afterActionMs` (capped at `settle.maxMs`), so the next snapshot isn't taken mid-mutation. Execute calls it after every dispatched action, and records the elapsed time on the Observation as `settleMs`.

The heavier "is the page actually done changing?" question is answered by the loop's no-change short-circuit (above), which polls the content hash rather than the wall clock. A future refinement can make `settle()` itself event-driven — return on the first of `Page.lifecycleEvent` (`networkAlmostIdle`/`load`) or an AX-tree-quiet window — but the hash-poll already covers the practical case without per-poll CDP wiring.

The LLM verb `wait` is *not* the settle mechanism — it's for deliberate pauses (animation, debouncing, throttled UI). Settle still runs after every `wait`.

After a URL-changing action, Loop also retries sparse snapshots before prompting (`loop.maxSparsePageRetries`, `loop.sparsePageRetryMs`, `loop.sparsePageMinNodes`). This catches pages that have committed navigation but not yet hydrated enough DOM/accessibility content, avoiding premature screenshot fallbacks on temporarily empty pages.

Loop tracks consecutive scrolls with the same direction on the same page. Once `loop.maxSameDirectionScrolls` is reached, it adds a warning to prompt history telling the model to pivot, save findings, go back, or finish. This is advisory, not a hard rejection. The legacy `loop.maxSameIntentScrolls` key is still accepted as a fallback.

---

## Loop semantics

Loop is the only stateful module. Everything else is pure.

### Step 0: plan of action (`lib/planning.js`)

Before the loop begins, the loop makes one **planning call** (`models.plan`, default `gpt-5.5`/`high`, enabled). It turns the bare task into a short prose **plan of action** — how the agent intends to use the web, and what the finished report needs to contain — formed from the task and trusted `context` alone, **before any page is seen**. The plan is an *immutable north star*: it is generated once and threaded into three downstream prompts so every stage shares one reading of the task —

- the **planner's** system prompt, on every turn (it rides inside the cached prefix — see *Prompt construction*),
- each **reflection** turn (so reflection judges progress against the plan, not just the task), and
- the final **report** (so the report's structure is pre-committed and the evidence was gathered *for* it).

It is *not* a script: the live page is always ground truth, and mid-run re-routing is the job of reflection, not a rewrite of the plan. Because it is built only from trusted inputs (never page content), it carries no prompt-injection surface. A failure here never breaks the run — `runArtifact.plan` stays `null` and every consumer omits the (empty) block, so the run proceeds exactly as if Step 0 were disabled. The plan is recorded on the Run artifact and surfaced in the stdout handoff.

### The loop body

```
1. snapshot  = extract(session)            // polls while unchanged (no-change short-circuit)
2. llmView   = reduce(snapshot)
3. completion = plan({ system, tools, messages: [ turnMessage(task, events, llmView) ], provider, model })
4. actions   = validate(completion.actions, snapshot.lookup, registry)
5. for each action:
     observation = execute(action, session)   // settles internally
     steps.push({ action, observation })
     events.push(describe(action, observation))   // compact memory; see § Memory below
     if action.verb === "done" → exit "completed"
6. goto 1
```

### Memory: event log, not transcript

The model is stateless across model calls, so each turn must carry the agent's progress. The naive approach — replay the full transcript (every past `LLMView` snapshot + each `tool_use`/`tool_result`) — grows **quadratically**: turn *N* re-sends *N* snapshots, so a 30-step run bills ~N²/2 listings.

Instead, Loop keeps a compact, deterministic **event log** of what *happened* and rebuilds a single user message each turn from `[ task, event log, current page ]`:

```
Task: <task description>

What you've done so far:
  1. typed "ada@example.com" into "Email"
  2. typed "hunter2" into "Password"
  3. clicked "Sign in"
  4. page navigated to https://acme.test/dashboard
  5. ✗ clicked "Forgot password?" — rejected: <reason>

Current page (1280x800) — the [@e…] refs below are valid only for this snapshot:
<latest LLMView listing>

Choose the single best next action, or emit "done" when the task is complete.
```

Each model call is therefore just `{ system, tools, messages: [ <one user message> ] }`:

- **Linear, not quadratic.** Only the current page is ever shown in full; old snapshots collapse to one event line each. The system prompt + tool defs remain the stable, cacheable prefix.
- **Provider-agnostic with no pairing.** Because no `tool_use`/`tool_result` blocks are replayed, there is no `tool_use_id` to thread and no role-alternation constraint — every provider gets a single user turn.
- **Derived, not summarized by a model.** The turn log comes straight from the Steps the loop already records (`describeAction` resolves a ref to its element name) plus URL deltas, so it costs no extra LLM call and can't hallucinate state.
- **Intent breadcrumbs.** Each tool schema requires `intent` metadata. The validator requires it to be non-empty and under 15 words, and the loop logs it next to the action so the next turn knows why the agent is on the current page without adding another LLM call.

The known limitation: an event log captures actions, navigations, and errors, but not arbitrary page text that appeared and then vanished. The model must call `save_text` to preserve raw text evidence in `saved-manifest.json` for the final report.

### Failure handling

- A failed Observation is recorded as an event (`… — FAILED: <error>`) so the LLM sees it and decides what to do next. **Loop never retries automatically.**
- Validate failures (LLM emitted a ref not in lookup, an unknown verb, malformed args) are recorded as rejected-action events (`✗ … — rejected: <error>`), so the next turn the LLM sees what it tried and why it was refused.
- Infrastructure errors (lost CDP connection, provider returned non-JSON, settle timed out 3x in a row) abort with status `failed`.

### Abort conditions

| Condition | Status |
|---|---|
| `done` verb emitted | `completed` |
| Step count exceeds `maxSteps` (default: 30) | `max-steps` |
| Loop passes exceed `maxIterations` (absolute ceiling, counts everything) | `max-iterations` |
| Infrastructure error or unrecoverable exception | `failed` |
| External cancel (`AbortSignal`) | `aborted` |

### Reflection: the "moment of silence" (`lib/reflect.js`)

The stuck/empty-plan aborts above are blunt: a flailing agent is killed rather than redirected. Reflection inserts a chance to recover *before* those aborts fire. When the loop detects the agent is flailing — `stuckStreak` or `emptyPlanStreak` hitting its threshold — or crosses a budget fraction (`reflect.budgetTurnFraction` of `maxSteps`, fired once), it runs one **reflection turn**: a model call with **no tools and no page listing**, handed the task, the run's plan of action (see *Step 0*), and a clip of the scratchpad manifest (`saved-manifest.json`). Stripped of the live page, the model judges its own trajectory and returns a single `<15-word` decision — stay the course, or pivot in concrete action terms.

- **Loop-triggered, not a verb.** The model deepest in a loop is the least likely to ask for a pause, so the loop fires it on the signals it already computes; it is not in the action registry.
- **Its own model.** `reflect.provider`/`reflect.model` are independent of the planner (default `gpt-5.5`), so a cheap planner can pause to think on a stronger model. `null` falls back to the planner's provider/model.
- **Persisted as an event.** The decision line is pushed into the event log as a permanent step, so every subsequent turn reads the pivot. The long-form reasoning is *not* requested (fewer output tokens). The final report is synthesized from `saved-manifest.json`, not the event log, so reflection decisions do not leak into the deliverable unless the agent explicitly saved them as evidence.
- **Bounded.** Capped at `reflect.maxReflections` per run with a `reflect.cooldownTurns` gap, so it can't reflect itself to death. A reflection turn is refunded from `maxSteps` (`iter--`) — it doesn't cost the agent working budget — but still counts toward the absolute `maxIterations` ceiling.
- **Clean re-entry.** On firing it clears the flailing guards and `lastHash`, forcing a fresh extract so the pivot acts on a real page. If reflection is unavailable (disabled, capped, or in cooldown), the original abort proceeds as before.
- **Scratchpad clipping.** Reflection receives a bounded clip of `saved-manifest.json` capped by `reflect.savedMaxChars`, so a long run can still pause without dumping unlimited saved evidence into the reflection prompt.

---

## Providers

### Interface

Every provider is an **adapter** conforming to `lib/providers/types.d.ts` (advisory
JS types — no build step):

```js
module.exports = {
  name: 'anthropic',
  defaultModel: 'claude-opus-4-7',
  defaultVisionModel: 'claude-opus-4-7',
  capabilities: { reasoningEffort: false, vision: true, toolUse: 'native', cache: 'explicit' },
  async callModel(req) { … },  // one model call (tool-calling or prose) → Completion
  async describe(req) { … },   // single-shot vision (image in, prose out) → VisionResult
};
```

```
plan req     = { system, tools, messages, model, cacheKey, reasoningEffort, maxTokens, signal }
describe req = { model, prompt, imageBase64, mimeType, maxTokens, signal }
```

Both envelopes (`Completion`, `VisionResult`) are built by `_shared.js`, so every
provider returns the same shape and the loop stays provider-agnostic.

### Registry & self-registration

Adapters self-register in `lib/providers/index.js` via `register()`, which
shape-checks each adapter against the contract at load time (a clear error beats
a deep runtime throw; the `vision: true` capability requires a `describe()`).
The registry is a mutable object keyed by name — `model.js` looks adapters up by
name, and tests inject a fake adapter by direct assignment. Set
`BROWSER_AGENT_SKIP_ADAPTER_CHECK=1` to bypass the guard.

### Capability-aware dispatch

`callModel()` consults `adapter.capabilities` and strips request fields the adapter
can't use — today, `reasoningEffort` for providers that don't support it —
emitting a one-time warning instead of letting the field be silently ignored.

### Error taxonomy & redaction

Provider failures from `_shared.postJSON` carry a normalized `err.type`
(`auth | rate_limit | invalid_request | server | timeout | network |
invalid_response | aborted`) plus `provider`, `status`, and `retriable`, so the
loop reacts uniformly rather than string-matching messages (it records
`errorType` on the Run and surfaces it). Error strings pass through `redact()`,
which scrubs credential-shaped substrings (`Bearer …`, `sk-…`, `AIza…`,
`?key=…`) before they're thrown or logged — defense-in-depth, since keys live in
headers, not bodies.

### Selection & defaults

Provider is resolved in this order: the `provider` arg to `callModel()` / `run()` → `BROWSER_AGENT_PROVIDER` env → `DEFAULT_PROVIDER` (`'openai'`). Mirrors the executor selection pattern. The vision provider/model are configured independently under `config.models.vision` (see `lib/vision.js`, which owns prompt/normalization and dispatches through the registry).

| Provider | Module | Default model | Vision model | Credentials | Caching |
|---|---|---|---|---|---|
| `openai` (default) | `providers/openai.js` | `gpt-5.4-mini` | `gpt-5.4-mini` | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | automatic |
| `anthropic` | `providers/anthropic.js` | `claude-opus-4-7` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL`) | explicit breakpoints |
| `gemini` | `providers/gemini.js` | `gemini-3.1-pro` | `gemini-3.5-flash` | `GEMINI_API_KEY` (+ `GEMINI_BASE_URL`) | implicit + explicit |
| `ollama` | `providers/ollama.js` | `llama3.1` | `llama3.2-vision` | none (local; `OLLAMA_HOST`) | local KV |

All four are implemented with native `fetch` (no vendor SDK), sharing the request/retry/Completion scaffolding in `_shared.js`. They speak the same generic `{ system, tools, messages }` request and return the same `Completion` artifact, so the loop is provider-agnostic.

### Tool definitions

Generated once per Run from `actions.js`:

```js
{ name: "click", description: "...", inputSchema: { ref: "string" } }
{ name: "type",  description: "...", inputSchema: { ref: "string", text: "string" } }
…
```

Each provider's `callModel()` translates these generic tool defs into its native format (Anthropic `tool_use`, OpenAI / Ollama function calling, Gemini `functionDeclarations`). The rest of the engine doesn't care.

---

## Prompt construction

`lib/prompt.js` owns the system prompt. The English template (behavior, constraints, output format hints) is in `prompt.js`. The available-actions section is **auto-generated from `actions.js`** so it can never drift from the registry.

```js
const prompt = require('./prompt');
const actions = require('./actions');

const system = prompt.buildSystemPrompt(actions, config.context, runArtifact.plan);
// → "You are a browser agent. Available actions: …\n\nPlan of Action (…): …\n\nContext (trusted …): …"
```

The system prompt is built once per Run — after *Step 0* produces the plan, so the plan rides inside it — and sent as the first message of every model call.

**Optional context and plan.** Two authoritative per-run blocks are appended to the **tail**, after the byte-identical template + action list that form the cacheable prefix (see *Caching seams*) — placing them earlier would invalidate the cache for everything after them. `config.context` (also `BROWSER_AGENT_CONTEXT` / `--context`) is operator-supplied background — who the user is, preferences — and the **plan of action** is the agent's own Step-0 plan for this run. The plan sits *before* context so `context` remains the very last block (nothing cacheable follows it). Each block — header included — is omitted entirely when its value is null/empty, so a disabled/failed Step 0 or absent context changes nothing.

---

## Prompt caching

The system prompt and tool definitions are byte-identical across a run's 30–50 turns (only the per-turn user message changes), so both providers cache that prefix. The dynamic turn message is always last; the optional operator `context` lives at the end of the system block (see *Prompt construction*), so a per-run context value never sits between two cacheable blocks.

**Anthropic** (`providers/anthropic.js`) — explicit breakpoints via `cache_control: { type: "ephemeral" }`. The cache hierarchy is tools → system → messages. We set two breakpoints: one on the **last tool** and one on the **system block**. Within a run both hit on turns 2..N. The split matters across runs: when `context` differs the system breakpoint misses, but the unchanged tools prefix still hits via its own breakpoint instead of being re-billed with system. Hits show up as `cache_read_input_tokens`; a miss just costs full input tokens (no downside).

**OpenAI** (`providers/openai.js`) — caching is automatic for prompts ≥1024 tokens (no breakpoints). It caches the longest common prefix and routes by a hash of the first ~256 tokens, so we keep static fields (tools, then system) first and the turn message last. Two levers from the caching guide:
- `prompt_cache_key` — set to the run id (threaded from `loop.js` as `req.cacheKey`), combined with the prefix hash to keep a run's turns sticky to one machine. A run does ~1 request/turn, well under the ~15 req/min/key overflow ceiling.
- `prompt_cache_retention` — optional, via `OPENAI_PROMPT_CACHE_RETENTION` (e.g. `24h`). Left unset by default so each model uses its own default and models that don't support extended retention aren't sent a field they'd reject.

Hits surface as `usage.prompt_tokens_details.cached_tokens`.

**Ollama** (`providers/ollama.js`) — automatic KV-cache prefix reuse, local and with no API parameter (so `cacheKey` is ignored). It reuses computation for a byte-identical prompt prefix while the model is loaded, which the static-first / dynamic-last ordering already provides. The lever here is lifetime: Ollama unloads the model and dumps its KV cache after `keep_alive` of inactivity (default 5m). Per-turn requests refresh that timer, so a run stays warm; set `OLLAMA_KEEP_ALIVE` (e.g. `30m`, or `-1` for forever) to keep the cache across back-to-back runs. Ollama reports no separate cached-token count.

### Other caching seams (not implemented)

| Seam | Where | What would be cached |
|---|---|---|
| Brief diff | `loop.js` | `briefHash` comparison: if a new Brief has the same hash as the previous one, optionally skip the model call entirely. (Partially realized: the no-change short-circuit polls instead of re-prompting.) |
| Element resolution | `lib/execute.js` | `backendNodeId → nodeId` (from `DOM.requestNode`). Lifetime: one Brief. Invalidated on re-snapshot. |
| LLMView | `reduce.js` | `briefHash → LLMView` map. Trivial — Reduce is pure. |

These remain additive: a new module wrapping an existing call, never a refactor of the call site.

---

## Build sequence

### Slice 1 — vertical, minimal, anthropic-only

Three verbs, happy path, one provider. Goal: get a real brief through a real LLM and dispatch real actions back to a real Chrome tab. No retries, no `text` in the listing, no observability beyond `console.error`.

1. `actions.js` — `click`, `type`, `done` only.
2. `prompt.js` — system prompt template + vocab generator.
3. `reduce.js` — deterministic listing of `elements` only.
4. `providers/anthropic.js` + `model.js` — tool-use mode, no caching yet.
5. `validate.js` — regex, lookup membership, refType, args shape.
6. `session.settle()` + `execute.js` — universal settle; dispatch three verbs via CDP.
7. `loop.js` — orchestrator, message conversion, Run construction, max-steps guard.
8. Smoke test: a real task against a real page (e.g., "search for X on any page").

### Slice 2 (after slice 1 runs end-to-end)

- Remaining verbs: `focus`, `press`, `scroll`, `navigate`, `wait`.
- `text` in LLMView (optional; controlled by Reduce flag).
- `briefHash` computed and threaded through artifacts.
- Persistence: write Run as JSON to a configurable directory.
- Additional providers: `openai.js`, `ollama.js`.

### Slice 3+

- Caching seams activated (in order of impact: Anthropic prompt cache → brief diff → element resolution → LLMView).
- Eval harness: replay a saved Run against a different model.
- Multi-tab support: implemented for following popups/new tabs (see Tab following). Per-element interaction inside a cross-origin OOPIF tab remains deferred.

---

## Open / deferred decisions

These are noted here so they don't get forgotten, but they don't block slice 1.

- **History truncation policy.** When does Loop summarize or drop old Steps? Defer until a real task overflows.
- **Tool-result formatting for non-tool-use providers.** Ollama and older OpenAI models don't have native tool use. The provider adapter must serialize tool calls as text. Decide per-provider when those providers land.
- **Concurrency.** First version dispatches one action per turn. The Action shape supports arrays so batched actions can be added later, but the loop body is serial.
- **Screenshot in LLMView.** Browser Agent's brief is text-only by design. Adding a screenshot would change the contract and the prompt-cache strategy. Defer until there's evidence the LLM needs visual context.
- **Goal/task input shape.** Free-form string for slice 1. Structured (sub-goals, constraints) later if needed.
- **Multi-frame / iframe handling.** Extract currently flattens. Same in execute. Real iframe support is a larger change — defer.

---

## Glossary

- **Brief** — the snapshot artifact emitted by `extract.js`. Contains elements, text, lookup, viewport.
- **Ref** — a short opaque string identifying an element or text node in a Brief, of the form `@e<n>` or `@t<n>`. See [README.md § Reference convention](README.md).
- **LLMView** — the prompt-ready, deterministic, text-formatted representation of a Brief. No `lookup`.
- **Step** — one `(Action, Observation)` pair.
- **Run** — the top-level artifact representing one task execution: task string, steps, completions, status.
- **Settle** — the wait-for-page-stable primitive on Session, called after every executed action.
- **Seam** — a named interface where a future cache, log, or replacement implementation can be added without refactoring callers.
