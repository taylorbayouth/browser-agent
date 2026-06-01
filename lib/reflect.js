'use strict';

// The reflection turn. A deliberate pause, triggered by the loop when it
// detects the agent is flailing (repeating a dead action, returning no actions)
// or burning through its step budget. We strip the live page away entirely and
// hand the model only the arc of its task — the scratchpad of what it has
// gathered — so it can judge its own trajectory without the distraction of the
// pixels in front of it, and decide whether to stay the course or change shape.
//
// Distinct from a normal turn: no tools, no page listing. The model returns one
// short line — a decision — which the loop both logs as a permanent step and
// hands to the very next turn as a highlighted directive (see loop.maybeReflect
// + buildTurnMessage). Long-form reasoning is intentionally NOT requested: we
// want the pivot, not an essay, and fewer output tokens.

const { callModel } = require('./model');

// The whole prompt is tuned to push genuine divergence — a change in the SHAPE
// of the approach — rather than "try the same thing harder". The live page is
// deliberately absent so the model reasons about the journey, not the screen.
const REFLECT_SYSTEM =
`You are a browser agent pausing mid-task to reflect — a deliberate step back
from the page to judge your own progress. The live page is hidden on purpose:
this is about the arc of your task, not the pixels in front of you.

A pivot changes your ROUTE, never your DESTINATION. The goal — what the finished
result must contain — does not move. What you reconsider is only how you get there.

Look honestly at your trajectory. Are your recent actions producing new, useful,
varied results — or are you circling the same ground, scraping diminishing
returns from one approach?

  - If you are still making real progress toward the goal, say so and stay the course.
  - If you are not, do not push harder on a path that isn't paying off. Change
    the SHAPE of the route: a different source, a different search, a different
    entry point. Abandon the path that has stalled and commit to a genuinely
    distinct one — while still aiming at the same goal.

If a plan of action is shown, it holds two things: the destination (what to
capture) and a first guess at the route (where to start). Treat the destination as
fixed and weigh your progress against it. The route was written before you had
seen any page, so revise it freely where reality has disproven it — but never
abandon the destination itself.

Respond with ONE line, under 15 words: your decision. If you are pivoting, name
the new direction in concrete action terms — where you will go and what you will
do next, not vague intent. No preamble, no explanation, just the line.`;

// Keep every heading visible (so an early finding never becomes invisible) plus
// the most recent `maxChars` of full body text. Truncating by pure recency would
// drop the earliest findings, which on a research task are often the ones that
// matter most — so we preserve the skeleton and trim only the detail.
function clipSaved(md, maxChars = 16000) {
  const text = String(md ?? '').trim();
  if (!text || text.length <= maxChars) return text;
  const headings = text.split('\n').filter(l => /^#{1,6}\s/.test(l));
  const tail = text.slice(text.length - maxChars);
  const skeleton = headings.length
    ? `(Earlier findings — headings only, full text trimmed for length:)\n${headings.join('\n')}\n\n---\n…\n`
    : '…\n';
  return skeleton + tail;
}

function buildReflectMessage({ task, plan, url, title, saved, hint }) {
  const planBlock = typeof plan === 'string' && plan.trim()
    ? `\nYour plan of action for this run (set before you started):\n${plan.trim()}\n`
    : '';
  return {
    role: 'user',
    content:
`You are on "${title || '(untitled)'}" — ${url || '(no url)'}.

Task: ${task}
${planBlock}
What you have gathered and done so far:
${saved || '(nothing saved yet)'}
${hint ? `\n${hint}\n` : ''}
Decide: stay the course, or pivot. One line, under 15 words.`,
  };
}

// Run a single reflection turn. Reuses callModel() (same provider/model as the
// planner) with no tools, so the model replies in plain text. Returns the raw
// decision text plus the completion (for usage accounting). Callers compact the
// text to the persisted summary line.
async function reflect({ task, plan, url, title, saved, hint, provider, model, cacheKey, reasoningEffort, maxTokens, timeoutMs }) {
  const message = buildReflectMessage({ task, plan, url, title, saved, hint });
  const completion = await callModel(
    { system: REFLECT_SYSTEM, tools: [], messages: [message], model, cacheKey, reasoningEffort, maxTokens, timeoutMs },
    { provider }
  );
  const text = (completion.text || completion.refusal || '').trim();
  return { text, completion };
}

module.exports = { reflect, clipSaved, buildReflectMessage, REFLECT_SYSTEM };
