'use strict';

// Step 0 — the planning turn. A single LLM call made once, before the agent
// touches the browser, that turns the bare task into a short plan of action:
// how it intends to use the web to accomplish the task, and what the finished
// report needs to contain. The live page is deliberately absent — this is a
// prior formed from the task and trusted operator context alone, before any
// pixel is seen.
//
// The plan is an immutable north star for the whole run. It is threaded into
// three downstream prompts so every stage shares ONE reading of the task:
//   - the planner's system prompt, every turn (cached) — see lib/prompt.js
//   - each reflection turn                             — see lib/reflect.js
//   - the final report synthesis                       — see lib/report.js
// It is NOT a rigid script: the live page is always ground truth, and mid-run
// re-routing is the job of the reflection mechanism, not a rewrite of this plan.
//
// Because it is built only from trusted inputs (task + operator context) and
// never from page content, the plan is itself trusted — it carries no
// prompt-injection surface.

const { callModel } = require('./model');

// Tuned to capture the two facets that actually carry through a run: the web
// APPROACH (so the planner starts well and trusts the right sources) and the
// PAYOFF (so the planner gathers — and the report can present — the specific
// evidence the task needs). For record-collection tasks, it also returns a
// small record contract, so the loop can count final deliverables without
// guessing from task wording or conflating evidence saves with complete records.
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

  return `You are a browser agent about to begin a task in a real Chrome browser. Before
you touch the page, think about how you will actually carry this out on the web
and what the finished result needs to contain — then write a short plan of action
and classify the task shape.

Cover, in 2 to 4 sentences of plain prose and only where they genuinely apply:
  - Approach: how you would go about this on the web — where to start, the kinds
    of sources worth trusting, and what to be wary of (sponsored or SEO-spam
    results, a single unverified page, stale information).
  - Payoff: what the final report needs to contain to truly satisfy the task —
    the specific facts, fields, comparisons, numbers, or artifacts worth
    capturing along the way so they are on hand at the end.

These two facets are not equal. The PAYOFF is your destination — what the finished
result must contain — and it does NOT change during the run. The APPROACH is only
your opening route to that destination: a first guess, made before you have seen
any page, that you may revise freely as the live page teaches you more. So this is
a north star, not a rigid script — the destination holds, the route can bend, and
the live page is always ground truth.

Commit only to what you can reasonably know now — do NOT invent specific sites,
prices, names, dates, or findings you cannot yet know; describe the shape of the
work, not imagined results.

${modeRule}

For taskType "records", include a recordContract:
  - recordName: singular noun for one final deliverable item, e.g. "job",
    "contact", "vendor", "grant", "lead".
  - target: requested number of complete records. If mode=records and no explicit
    number exists, use 1.
  - requiredFields: object mapping required field names to short descriptions.
    A record should not count until these are present.
  - optionalFields: object mapping nice-to-have field names to short descriptions.
    These should improve quality but never block completion.

For taskType "research", recordContract MUST be null. The run should finish by
using saved evidence and calling done; there is no record-ledger auto-stop.

Reply with ONLY valid JSON matching this shape:
{
  "plan": "2-4 sentences of prose.",
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
Write your plan of action now.`,
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
  const requiredFields = asFieldObject(value.requiredFields);
  return {
    recordName,
    target,
    requiredFields: Object.keys(requiredFields).length ? requiredFields : { result: 'Final requested result' },
    optionalFields: asFieldObject(value.optionalFields),
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
  if (!text) return { plan: '', taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null };
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { plan: text, taskType: normalizedMode === 'records' ? 'records' : 'research', recordContract: null };
  }
  const plan = String(parsed.plan || '').trim();
  const normalizedContract = normalizeRecordContract(parsed.recordContract);
  const taskType = normalizeTaskType(parsed.taskType, normalizedContract, normalizedMode);
  return {
    plan: plan || text,
    taskType,
    recordContract: taskType === 'records' ? normalizedContract : null,
  };
}

// Run the single Step-0 planning call. Reuses callModel() with no tools, so the
// model replies in JSON. Returns parsed plan prose, the optional record contract,
// and the completion for usage accounting.
async function generatePlan({ task, context, mode = 'auto', provider, model, cacheKey, reasoningEffort, maxTokens, timeoutMs }) {
  const message = buildPlanMessage({ task, context });
  const completion = await callModel(
    { system: buildPlanSystem(mode), tools: [], messages: [message], model, cacheKey, reasoningEffort, maxTokens, timeoutMs },
    { provider }
  );
  const rawText = (completion.text || completion.refusal || '').trim();
  const parsed = parsePlanResponse(rawText, { mode });
  return { text: parsed.plan, taskType: parsed.taskType, recordContract: parsed.recordContract, rawText, completion };
}

module.exports = {
  generatePlan,
  buildPlanMessage,
  buildPlanSystem,
  parsePlanResponse,
  normalizeRecordContract,
  PLAN_SYSTEM,
};
