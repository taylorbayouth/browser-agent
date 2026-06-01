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
// prompt-injection surface. For record-collection tasks it also returns a small
// record contract, so the loop can count final deliverables without guessing from
// task wording or conflating evidence saves with complete records.

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

  return `You are the first stage of a browser agent. Before any page is touched, your job
is to REWRITE the operator's task into one complete, self-contained instruction the
agent will follow for the entire run — and to classify the task shape.

This rewrite becomes the agent's ONLY statement of what to do; the operator's
original wording is discarded in favor of yours. So it must be faithful and
complete:
  - Preserve every detail and the full intent and spirit of the request. Do not
    drop, weaken, or generalize any requirement, constraint, target count, field,
    format, exclusion, or nuance — losing a detail here loses it for the whole run.
    This is critical.
  - Fill gaps and strengthen. Resolve ambiguity sensibly, make implicit
    requirements explicit, and add the structure, sequence, and success criteria
    that make the instruction maximally effective for an LLM to execute well.
  - State the deliverable plainly: what the finished result must contain — the
    specific facts, fields, comparisons, numbers, or artifacts to capture — so the
    agent gathers them as it goes and the final report has them on hand.
  - You may suggest a sensible opening approach (where to start, sources to trust,
    traps to avoid: sponsored or SEO-spam results, a single unverified page, stale
    data), but frame approach as guidance, not a rigid script — the live page is
    always ground truth and the agent may re-route freely.

Phrase the instruction in the verbs the agent's executor actually understands, so
it reads as concrete actions. Canonical mappings:
  - "download/save/grab/capture an image or screenshot" → take_screenshot
  - "save/download/get a file or attachment"            → save_file (after get_files)
  - "record/log/collect an item or result"              → save_record
  - "note/jot/remember some text or findings"           → save_text
  - "go to/open/visit a URL or page"                    → navigate
  - "click/tap/press/hit/select an element"             → click
  - "type/enter/fill/write into a field"                → type
  - "scroll/page down or up"                            → scroll
  - "press a key (Enter, Tab, Escape, …)"               → press
  - "go back / previous page"                           → back
  - "pause/wait/sleep"                                  → wait
  - "highlight/select text on the page"                 → select_text
  - "finish/done/complete/stop the run"                 → done
Use these canonical verb names in the rewritten instruction so the agent interprets
them unambiguously.

Commit only to what you can reasonably know now — do NOT invent specific sites,
prices, names, dates, or findings you cannot yet know; describe the work and its
requirements, not imagined results.

${modeRule}

For taskType "records", include a recordContract:
  - recordName: singular noun for one final deliverable item, e.g. "job",
    "contact", "vendor", "grant", "lead".
  - target: requested number of records. If mode=records and no explicit
    number exists, use 1.
  - fields: object mapping field names to short descriptions — everything worth
    capturing for one record. Gather as many as the page offers, but a missing
    field NEVER blocks saving a record: save one record per item with whatever you
    found. Do not split fields into required vs optional — they are all just
    fields to attempt.

For taskType "research", recordContract MUST be null. The run should finish by
using saved evidence and calling done; there is no record-ledger auto-stop.

Reply with ONLY valid JSON matching this shape:
{
  "task": "The rewritten, complete instruction — every requirement preserved, gaps filled, phrased in the agent's verbs.",
  "taskType": "records",
  "recordContract": {
    "recordName": "result",
    "target": 1,
    "fields": {
      "answer": "Final answer or requested result"
    }
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
  const target = Number(value.target);
  if (!Number.isInteger(target) || target <= 0 || target > 100) return null;
  const recordName = String(value.recordName || 'result').trim() || 'result';
  // One flat field map — no required/optional tiers, so a missing field never
  // gates a save. Legacy requiredFields/optionalFields are merged in so an older
  // planner response still parses into the same shape.
  const fields = {
    ...asFieldObject(value.requiredFields),
    ...asFieldObject(value.optionalFields),
    ...asFieldObject(value.fields),
  };
  return {
    recordName,
    target,
    fields: Object.keys(fields).length ? fields : { result: 'Final requested result' },
  };
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
  if (!text) return { task: '', taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null };
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
  // Non-JSON output is treated as the rewritten task verbatim — a usable fallback
  // rather than a discard.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { task: text, taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null };
  }
  // Accept legacy `plan` as an alias so an older Step-0 response still yields a task.
  const task = String(parsed.task || parsed.plan || '').trim();
  const normalizedContract = normalizeRecordContract(parsed.recordContract);
  const taskType = normalizeTaskType(parsed.taskType, normalizedContract, normalizedMode);
  return {
    task: task || text,
    taskType,
    recordContract: taskType === 'records' ? normalizedContract : null,
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
  return { task: parsed.task, taskType: parsed.taskType, recordContract: parsed.recordContract, rawText, completion };
}

module.exports = {
  generatePlan,
  buildPlanMessage,
  buildPlanSystem,
  parsePlanResponse,
  normalizeRecordContract,
  PLAN_SYSTEM,
};
