'use strict';

const fs = require('fs');
const path = require('path');

// Single home for tunable knobs. Resolution order, lowest to highest priority:
//   DEFAULTS  <  browser-agent.config.json  <  env vars  <  explicit args (CLI)
//
// loadConfig() returns the merged DEFAULTS+file+env config; callers (agent.js)
// layer CLI flags on top via deepMerge before passing it to run().

const DEFAULTS = {
  context: null,                 // optional operator-supplied background (user info,
                                 // preferences) injected as a trusted block at the end
                                 // of the system prompt. null → no Context section.

  // ── Models ──────────────────────────────────────────────────────────────────
  // The five model roles, defined together so it's obvious which model does what:
  // plan (Step 0) → primary (planner) → vision → reflect → report.
  // Each role is independent: its own provider, model, and per-request timeout
  // (ms) — so a heavy role (report) can run long while the interactive ones
  // (primary/vision) fail fast. reasoningEffort applies to OpenAI gpt-5/o-series
  // reasoning models (minimal|low|medium|high; null disables the field, e.g. for a
  // non-reasoning model); it's ignored by providers that don't support it.
  models: {
    // 0. PLAN — "Step 0". One call made once at run start (lib/planning.js),
    //    before the agent touches the page, that turns the bare task into a short
    //    prose plan of action: how it will use the web, and what the final report
    //    needs to contain. The plan is an immutable north star, threaded into the
    //    planner's system prompt (every turn), each reflection, and the final
    //    report — so every stage shares one reading of the task. Built from the
    //    task + trusted context only (never page content), so it adds no
    //    prompt-injection surface. If disabled or the call fails, the run simply
    //    proceeds with no plan, exactly as before. maxTokens is omitted → the
    //    provider default (ample for a few sentences plus reasoning), like
    //    reflect/report.
    plan: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-5.5',            // a stronger model to think before acting, independent of the planner
      reasoningEffort: 'high',
      timeoutMs: 30000,
    },

    // 1. PRIMARY — the planner. Runs every turn; chooses the next action.
    primary: {
      provider: 'openai',          // openai | anthropic | gemini | ollama
      model: null,                 // null → the provider's own default model
      reasoningEffort: 'high',     // minimal|low|medium|high|null
      maxTokens: 4096,
      timeoutMs: 10000,
    },

    // 2. VISION — describes screenshots (the take_screenshot verb). Independent of
    //    the planner, so a cheap planner can pair with a strong vision model.
    vision: {
      provider: 'openai',
      model: null,                 // null → provider's default multimodal model
      prompt: 'Describe the image/page in detail, 1500-2000 chars.',
      maxTokens: 1024,
      timeoutMs: 10000,
    },

    // 3. REFLECT — a loop-triggered pause-and-think turn (lib/reflect.js). When the
    //    agent shows signs of flailing (stuck/empty-plan) or crosses a budget
    //    threshold, the page is stripped away and it judges its own trajectory,
    //    returning one <15-word decision the next turn reads.
    reflect: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-5.5',            // independent of the planner — pause to think on a stronger model
      reasoningEffort: 'high',
      timeoutMs: 30000,
      maxReflections: 10,          // hard cap on reflections per run
      cooldownTurns: 4,            // minimum turns between reflections (no back-to-back firing)
      budgetTurnFraction: 0.6,     // fire one budget reflection once past this fraction of maxSteps
      savedMaxChars: 16000,        // max scratchpad manifest chars fed into reflection
    },

    // 4. REPORT — final synthesis. At run end, saved-manifest.json is handed to
    //    this model once. If disabled or unavailable, the loop falls back to a small
    //    deterministic evidence report. Given a generous timeout: a one-shot
    //    synthesis over the whole run's evidence is the slowest call in a run.
    report: {
      enabled: true,
      provider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      timeoutMs: 60000,
    },
  },

  chrome: {
    executablePath: null,         // explicit Chrome/Chromium executable path
                                 // (also BROWSER_AGENT_CHROME_PATH)
  },

  loop: {
    maxSteps: 30,                // hard cap on LLM turns (reflections don't count — see reflect)
    maxIterations: null,         // absolute ceiling on loop passes, counting EVERYTHING (reflections
                                 // included) so nothing can loop forever. null → maxSteps +
                                 // reflect.maxReflections + 10 buffer, computed at run start.
    shortCircuitOnNoChange: true, // skip the LLM call while the page is unchanged
    pollMs: 1500,                // wait between re-checks while the page is unchanged
    maxNoChangePolls: 10,        // give up waiting after this many polls and let the model act/finish
    maxStuckRepeats: 2,          // abort if the model repeats the same action with no page change this many times
    maxEmptyPlans: 1,            // reflect (then abort) after this many consecutive LLM turns with no tool action
    maxUrlVisits: 4,             // fire a reflection turn on the Nth arrival at the same page — circling back to seen pages
    revisitUrlMatch: 'content',  // how the revisit counter keys pages: 'content' (structural fingerprint — URL-independent, survives cache-busting/session params) | 'clean' (strip tracking params from URL) | 'full' (raw URL, exact match)
    maxSparsePageRetries: 4,     // after navigation, retry sparse snapshots before prompting
    sparsePageRetryMs: 400,      // wait between sparse post-navigation re-extracts
    sparsePageMinNodes: 2,       // elements + text + regions below this is considered sparse
    maxSameDirectionScrolls: 3,  // soft warning when same scroll direction repeats this many times on a page
    maxScrollReversals: 3,       // fire a reflection turn after this many scroll direction reversals (down↔up) on a page — oscillation = thrashing
  },

  settle: {
    afterActionMs: 150,          // pause after an action before the next snapshot
    maxMs: 2000,                 // hard cap on settle
  },

  view: {                        // how the brief is rendered for the LLM (reduce.js)
    includeText: true,           // interleave @t text nodes (headings, labels, prose)
    maxTextChars: 200,           // truncate long text node names
    dedupeText: true,            // collapse consecutive identical text nodes
    maxListingLines: 1000,       // hard cap on lines sent to the LLM (0 = unlimited).
                                 // This is the value the loop actually uses — it's
                                 // passed to reduce() as viewCfg and OVERRIDES
                                 // reduce.js's DEFAULT_VIEW, so keep the two in sync.
  },

  executor: {
    backend: 'os',               // os | cdp
    binPath: null,               // override path to the browser-input binary (os backend)
    pauseOnUserInput: true,      // os: pause input while the human uses the mouse/keyboard
    userIdleMs: 600,             // os: resume only after the human is idle this long
    raiseChromeOnStart: true,    // os: foreground the agent's Chrome at run start
    humanize: {
      enabled: true,
      mouseSpeedPxPerSec: 1400,
      mouseJitterPx: 2,
      keystrokeDelayMsMin: 25,
      keystrokeDelayMsMax: 85,
      postFocusPauseMs: 80,
      postClearPauseMs: 50,
      preClickPauseMsMin: 40,
      preClickPauseMsMax: 160,
      typeOmnibox: true,           // os: on navigate, glide to the address bar and type the URL
                                   // character-by-character (demo-quality visible motion).
                                   // The actual page load still uses CDP Page.navigate, not Enter,
                                   // so omnibox autocomplete cannot redirect the destination. Falls
                                   // back to a plain CDP navigate on any keystroke error.
    },
  },

  // Encoding of the image handed to the vision model. The model downscales
  // internally, so a lossless full-page PNG just burns bytes, tokens, and disk.
  // Quality is tiered by how the shot will be read: a whole-viewport "describe"
  // (take_screenshot with no ref) tolerates heavy compression, but a cropped
  // read (take_screenshot with a ref — usually small text, chart labels, or a
  // CAPTCHA) is effectively OCR, where JPEG artifacts eat thin glyphs, so it
  // gets a higher quality. format:'png' ignores both quality knobs.
  screenshot: {
    format: 'jpeg',              // jpeg | png
    quality: 55,                 // full-viewport describe (no ref)
    croppedQuality: 92,          // cropped @ref read
  },

  images: {
    targetAverageSidePx: 400,     // saved images are resized so (width + height) / 2 is at most this; 0 disables
  },

  log: {
    enabled: true,
    dir: 'logs',
  },
};

// Resolve a model role (plan | primary | vision | reflect | report) into the
// call config to hand a provider. Every secondary role inherits provider/model
// from `models.primary` wherever it leaves them null/unset, so a config that
// sets only `primary` still drives all five roles; `primary` is the base and
// inherits nothing. A null model stays null here — providers turn that into
// their own default at call time. All the role's other knobs (reasoningEffort,
// maxTokens, timeoutMs, enabled, …) pass through untouched. This is the ONE
// place the inheritance rule lives, so plan/reflect/report call sites can't
// drift apart. Pure read — never mutates cfg.
function resolveRole(cfg, role) {
  const models = (cfg && cfg.models) || {};
  const r = { ...(models[role] || {}) };
  if (role !== 'primary') {
    const base = models.primary || {};
    r.provider = r.provider || base.provider;
    r.model = r.model || base.model || null;
  } else {
    r.model = r.model || null;
  }
  return r;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Recursively merge `override` onto `base`. Nested plain objects merge; scalars
// and arrays replace. `undefined` values in override are skipped, so a partial
// override (e.g. a CLI flag setting only loop.maxSteps) never wipes siblings.
function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function applyEnvOverrides(cfg) {
  // Optional overrides — none are required (API keys live in .env, everything
  // else lives in browser-agent.config.json). BROWSER_AGENT_PROVIDER targets the
  // primary planner; per-role providers are configured in the file.
  if (process.env.BROWSER_AGENT_PROVIDER) {
    cfg.models = cfg.models || {};
    cfg.models.primary = cfg.models.primary || {};
    cfg.models.primary.provider = process.env.BROWSER_AGENT_PROVIDER;
  }
  if (process.env.BROWSER_AGENT_EXECUTOR) cfg.executor.backend = process.env.BROWSER_AGENT_EXECUTOR;
  if (process.env.BROWSER_AGENT_CONTEXT) cfg.context = process.env.BROWSER_AGENT_CONTEXT;
  if (process.env.BROWSER_AGENT_CHROME_PATH) {
    cfg.chrome = cfg.chrome || {};
    cfg.chrome.executablePath = process.env.BROWSER_AGENT_CHROME_PATH;
  }
  return cfg;
}

let cached = null;

class ConfigError extends Error {}

// The fields each model role legitimately accepts. A key outside this set is
// almost always a typo (e.g. `reflct:` or `timeout:`), which deepMerge would
// otherwise fold in silently — the misspelled role keeps DEFAULTS and the
// mistake never surfaces. We validate the *file* config (what the operator
// actually wrote), not the merged result, so only real mistakes are flagged.
const ROLE_FIELDS = {
  plan:    ['enabled', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'timeoutMs'],
  primary: ['provider', 'model', 'reasoningEffort', 'maxTokens', 'timeoutMs'],
  vision:  ['provider', 'model', 'prompt', 'maxTokens', 'timeoutMs'],
  reflect: ['enabled', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'timeoutMs', 'maxReflections', 'cooldownTurns', 'budgetTurnFraction', 'savedMaxChars'],
  report:  ['enabled', 'provider', 'model', 'reasoningEffort', 'maxTokens', 'timeoutMs'],
};
const VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

// Warn once per distinct message so a reload loop (tests) or a long run never
// spams stderr. Mirrors the warnOnce in lib/model.js.
const warnedConfig = new Set();
function warnConfig(msg) {
  if (warnedConfig.has(msg)) return;
  warnedConfig.add(msg);
  process.stderr.write(`[browser-agent] config: ${msg}\n`);
}

// Non-fatal structural check on the user's `models` block. Catches typo'd role
// names, typo'd/misplaced fields, and obviously-wrong value types — each as a
// one-line stderr warning, never a throw, so a stale field can't silently
// disable a whole role but also can't break an otherwise-runnable config.
function validateModels(models) {
  if (models == null) return;
  if (!isPlainObject(models)) {
    warnConfig(`"models" should be an object, got ${Array.isArray(models) ? 'array' : typeof models}`);
    return;
  }
  for (const [role, spec] of Object.entries(models)) {
    const allowed = ROLE_FIELDS[role];
    if (!allowed) {
      warnConfig(`unknown model role "${role}" — expected one of ${Object.keys(ROLE_FIELDS).join(', ')} (ignored)`);
      continue;
    }
    if (!isPlainObject(spec)) {
      warnConfig(`models.${role} should be an object, got ${typeof spec}`);
      continue;
    }
    for (const [field, value] of Object.entries(spec)) {
      if (!allowed.includes(field)) {
        warnConfig(`unknown field models.${role}.${field} (ignored) — valid: ${allowed.join(', ')}`);
        continue;
      }
      if (field === 'provider' && value != null && typeof value !== 'string') {
        warnConfig(`models.${role}.provider should be a string, got ${typeof value}`);
      } else if (field === 'model' && value != null && typeof value !== 'string') {
        warnConfig(`models.${role}.model should be a string or null, got ${typeof value}`);
      } else if (field === 'enabled' && typeof value !== 'boolean') {
        warnConfig(`models.${role}.enabled should be a boolean, got ${typeof value}`);
      } else if (field === 'reasoningEffort' && value != null && !VALID_EFFORTS.has(value)) {
        warnConfig(`models.${role}.reasoningEffort "${value}" is invalid — expected ${[...VALID_EFFORTS].join('|')} or null`);
      } else if (['maxTokens', 'timeoutMs', 'maxReflections', 'cooldownTurns', 'savedMaxChars'].includes(field) && value != null && !Number.isFinite(value)) {
        warnConfig(`models.${role}.${field} should be a number, got ${typeof value}`);
      }
    }
  }
}

// Load + merge config (DEFAULTS < file < env). Cached after first call; pass
// { reload: true } to force a re-read (e.g. in tests). The file path defaults
// to ./browser-agent.config.json, overridable via BROWSER_AGENT_CONFIG.
function loadConfig(opts = {}) {
  if (cached && !opts.reload) return cached;
  const file = opts.path
    || process.env.BROWSER_AGENT_CONFIG
    || path.resolve(process.cwd(), 'browser-agent.config.json');
  let fileCfg = {};
  if (fs.existsSync(file)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ConfigError(`Invalid config JSON in ${file}: ${e.message}`);
    }
  }
  validateModels(fileCfg.models);
  // Clone DEFAULTS first: deepMerge only shallow-copies the top level, so a
  // config without (say) an `executor` block would leave cfg.executor === the
  // shared DEFAULTS.executor — and applyEnvOverrides mutating cfg.executor.backend
  // would then corrupt the module-level DEFAULTS for the rest of the process.
  cached = applyEnvOverrides(deepMerge(structuredClone(DEFAULTS), fileCfg));
  return cached;
}

module.exports = { loadConfig, deepMerge, resolveRole, DEFAULTS, ConfigError };
