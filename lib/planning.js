'use strict';

// Step 0 — the task-expansion turn. A single LLM call made once, before the agent
// touches the browser, that REWRITES the operator's bare task into one complete,
// self-contained instruction: every requirement preserved, gaps filled, the whole
// thing strengthened for an LLM, and phrased in the verbs the executor actually
// understands. The live page is deliberately absent — this is formed from the task
// and trusted operator context alone, before any pixel is seen.
//
// The rewritten task replaces the operator's wording everywhere downstream and is
// the agent's ONE statement of what to do. It is threaded into three prompts so
// every stage shares ONE reading of the task:
//   - the planner's system prompt, every turn (cached) — see lib/prompt.js
//   - each reflection turn                             — see lib/reflect.js
//   - the final report synthesis                       — see lib/report.js
// It is NOT a rigid script: the live page is always ground truth, and mid-run
// re-routing is the job of the reflection mechanism, not a rewrite of the task.
//
// Because it is built only from trusted inputs (task + operator context) and never
// from page content, the rewritten task is itself trusted — it carries no
// prompt-injection surface. Alongside the prose task it also returns `requirements`:
// an enumerated checklist of every distinct thing the run must do or deliver, so
// imperative sub-steps ("collect X AND then do Y") survive as discrete, checkable
// items the planner works through before calling done, instead of dissolving into
// prose. For record-collection tasks it also returns a small record contract, so the
// loop can count final deliverables without guessing from task wording or conflating
// evidence saves with complete records — but the contract counts only; reaching its
// target never ends the run on its own (see lib/loop.js).

const { callModel } = require('./model');

function buildPlanSystem(mode = 'auto') {
  const normalized = normalizeMode(mode);
  const modeRule = normalized === 'records'
    ? `The operator explicitly set mode=records. taskType MUST be "records", and
recordContract MUST describe the final deliverable records to collect.`
    : normalized === 'research'
      ? `The operator explicitly set mode=research. taskType MUST be "research", and
recordContract MUST be null.`
      : `The operator set mode=auto. Choose taskType:
  - "records" when the task asks for a numbered collection/list of similar final
    items, e.g. jobs, contacts, vendors, grants, leads, papers, examples.
  - "research" when the task asks for investigation, comparison, explanation,
    recommendation, or synthesis without a clear final-record count.`;

  return `You are the first stage of a browser agent. Your job is to turn the operator's task
into the agent's complete marching orders: extract every requirement, then translate
each one into concrete instructions phrased in the verbs the agent executes. This is the
agent's one statement of what to do — completeness beats brevity. A requirement you drop
here is lost for the entire run.

Produce two things:

1. requirements — an enumerated checklist of every distinct thing the run must do or
   deliver. Capture ALL of them:
   - counts, fields, constraints, exclusions, and output format
   - EVERY action the operator asked for, not just the research. Tasks are often
     "collect X AND then do Y" (e.g. find jobs and message each contact; gather vendors
     and compare them; pull papers and rank them). Keep BOTH halves. Imperative steps
     (fill, apply, message, compare, rank, draft) are the easiest to lose when
     paraphrasing into research language — do not drop them.
   - If the operator asks to find, include, download, save, or collect photos,
     images, screenshots, product shots, diagrams, charts, or other visual media,
     the deliverable requires a physical saved asset. Add an explicit requirement
     to call save_image on the relevant @v region or save_file for the image URL
     before saving the record or calling done. A page URL plus prose blurb is not
     enough for these media tasks.
   One requirement per line, in execution order, each independently checkable so the
   agent can tell when every one is satisfied.

2. task — the same requirements written as one flowing instruction the agent follows end
   to end, in the agent's action vocabulary. Reframe the research steps the way a skilled
   web researcher would execute them (what to search, which sites and databases to check,
   how to triangulate sources, what to distrust — sponsored results, SEO spam, stale
   aggregators), but never let that reframing drop a non-research action. State the
   deliverable: what the finished result must contain.

Write using the agent's action verbs directly:
  navigate · click · type · scroll · press · back · wait · select_text
  save_record · save_text · save_image · save_file · take_screenshot · done

${modeRule}

For taskType "records", include a recordContract:
  - recordName: singular noun for one final deliverable item, e.g. "job",
    "contact", "vendor", "grant", "lead".
  - target: requested number of records. If mode=records and no explicit
    number exists, use 1.
  - requiredFields: object mapping field names to short descriptions for fields
    that will reliably appear on most records of this type without extra
    navigation or deep-clicking. Keep this short — 2-4 core identifying fields.
    If you are unsure whether a field will be consistently available, put it in
    optionalFields instead. The agent MUST have all required fields before
    calling save_record; an empty required set is valid if everything is optional.
  - optionalFields: object mapping field names to short descriptions for fields
    that may be absent, require navigating into a detail page, or only appear on
    some records. The agent attempts these but skips them if not visible — a
    missing optional field NEVER blocks saving a record.
The recordContract describes ONLY the deliverable records to collect — it is not the
whole task. Reaching the record target does not end the run on its own; any requirement
beyond collecting records (messaging each one, comparing them, etc.) stays in
requirements/task and must still be done before the agent finishes.
For photo/image/media records, include a required saved_asset field describing the
local image asset path produced by save_image or save_file; source URLs alone
do not satisfy the media deliverable.

For taskType "research", recordContract MUST be null. The run should finish by
using saved evidence and calling done; there is no record-ledger auto-stop.

Reply with ONLY valid JSON matching this shape:
{
  "requirements": [
    "First concrete requirement, in the agent's verbs.",
    "Second requirement, including any action beyond collecting records."
  ],
  "task": "The rewritten, complete instruction — every requirement preserved, gaps filled, phrased in the agent's verbs.",
  "taskType": "records",
  "recordContract": {
    "recordName": "result",
    "target": 1,
    "requiredFields": {
      "answer": "Final answer or requested result"
    },
    "optionalFields": {}
  }
}`;
}

const PLAN_SYSTEM = buildPlanSystem('auto');

function normalizeMode(value) {
  return ['auto', 'records', 'research'].includes(value) ? value : 'auto';
}

function buildPlanMessage({ task, context }) {
  const trustedContext = typeof context === 'string' && context.trim() ? context.trim() : '';
  return {
    role: 'user',
    content:
`Task: ${task}
${trustedContext ? `\nContext (trusted background from the operator — authoritative):\n${trustedContext}\n` : ''}
Rewrite this task now.`,
  };
}

function asFieldObject(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .map(v => [v, v])
    );
  }
  if (typeof value !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || '').trim();
    if (!key) continue;
    out[key] = String(v || key).trim() || key;
  }
  return out;
}

function normalizeRecordContract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Clamp rather than reject so an out-of-range target doesn't discard the whole
  // contract along with its recordName and fields.
  let target = Math.round(Number(value.target));
  if (!Number.isFinite(target) || target < 1) target = 1;
  if (target > 100) target = 100;
  const recordName = String(value.recordName || 'result').trim() || 'result';
  // Preserve the required/optional distinction: required fields are the minimum
  // a save_record needs; optional fields are attempted but never block a save.
  // Legacy responses that only supply a flat `fields` map are treated as all-required
  // so existing contracts keep working unchanged.
  const hasExplicitSplit = value.requiredFields || value.optionalFields;
  const requiredFields = hasExplicitSplit
    ? asFieldObject(value.requiredFields)
    : asFieldObject(value.fields);
  const optionalFields = hasExplicitSplit
    ? asFieldObject(value.optionalFields)
    : {};
  const hasAny = Object.keys(requiredFields).length || Object.keys(optionalFields).length;
  return {
    recordName,
    target,
    requiredFields: Object.keys(requiredFields).length
      ? requiredFields
      : (hasAny ? {} : { result: 'Final requested result' }),
    optionalFields,
  };
}

// The enumerated requirements checklist. Accept an array of strings (the documented
// shape) or a single string the model split with newlines/bullets, and reduce it to a
// clean, deduped, bounded list of one-line items. Anything unusable yields [] so the
// run simply proceeds on the prose task, exactly as before requirements existed.
function normalizeRequirements(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'string') {
    items = value.split('\n');
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = String(item == null ? '' : item)
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')   // strip a leading bullet/number the model may add
      .trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text.length > 300 ? `${text.slice(0, 299)}…` : text);
    if (out.length >= 20) break;   // a checklist, not a transcript — keep the prompt bounded
  }
  return out;
}

function normalizeTaskType(value, recordContract = null, mode = 'auto') {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === 'records') return 'records';
  if (normalizedMode === 'research') return 'research';
  if (value === 'records' || value === 'research') return value;
  return recordContract ? 'records' : 'research';
}

function parsePlanResponse(raw, { mode = 'auto' } = {}) {
  const text = String(raw || '').trim();
  const normalizedMode = normalizeMode(mode);
  if (!text) return { task: '', taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null, requirements: [] };
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  // Non-JSON output: plain prose is used verbatim as the rewritten task. But if
  // the text looks like it tried to be JSON (starts with '{') and both parse
  // attempts failed, the model produced a truncated/malformed JSON blob — using
  // that as the task would give the agent machine noise as its north star. Return
  // '' so effectiveTask = expandedTask || task falls back to the raw operator task.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (text.trimStart().startsWith('{')) {
      console.error('  (plan: malformed JSON in Step-0 reply; falling back to raw task)');
      return { task: '', taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null, requirements: [] };
    }
    return { task: text, taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null, requirements: [] };
  }
  // Accept legacy `plan` as an alias so an older Step-0 response still yields a task.
  const task = String(parsed.task || parsed.plan || '').trim();
  const normalizedContract = normalizeRecordContract(parsed.recordContract);
  const taskType = normalizeTaskType(parsed.taskType, normalizedContract, normalizedMode);
  return {
    task,
    taskType,
    recordContract: taskType === 'records' ? normalizedContract : null,
    requirements: normalizeRequirements(parsed.requirements),
  };
}

// Run the single Step-0 call. Reuses callModel() with no tools, so the model
// replies in JSON. Returns the rewritten task, the optional record contract, and
// the completion for usage accounting.
async function generatePlan({ task, context, mode = 'auto', provider, model, cacheKey, reasoningEffort, maxTokens, timeoutMs }) {
  const message = buildPlanMessage({ task, context });
  const completion = await callModel(
    { system: buildPlanSystem(mode), tools: [], messages: [message], model, cacheKey, reasoningEffort, maxTokens, timeoutMs },
    { provider }
  );
  const rawText = (completion.text || completion.refusal || '').trim();
  const parsed = parsePlanResponse(rawText, { mode });
  return {
    task: parsed.task,
    taskType: parsed.taskType,
    recordContract: parsed.recordContract,
    requirements: parsed.requirements,
    rawText,
    completion,
  };
}

module.exports = {
  generatePlan,
  buildPlanMessage,
  buildPlanSystem,
  parsePlanResponse,
  normalizeRecordContract,
  normalizeRequirements,
  PLAN_SYSTEM,
};
