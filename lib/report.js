'use strict';

const { callModel } = require('./model');

const REPORT_SYSTEM =
`You write final Markdown reports for a browser agent.

The browser run is complete. You will receive the original task, optional
trusted context, run status, optional final result/error, and the saved evidence
captured during browsing as a JSON manifest.

Write a task-specific Markdown report that directly satisfies the original task.
Use only the saved evidence and provided run metadata. Preserve source URLs.
For manifest saves with file_name, link or embed them as assets/<file_name>. Do
not invent facts, contacts, citations, or file contents. If the saved evidence is
incomplete, say what is missing. Keep the report useful to both an upstream LLM
and a human reader.

If the agent's plan of action is provided, let its intended deliverable guide the
report's structure, and check the evidence against what the plan set out to
capture — but never invent to fill a gap; note what the plan called for that the
run did not actually produce.

Think deeply about the best layout for this specific task and evidence. Choose
headings, tables, grouped sections, bullets, image/file embeds, and link labels
that make the data easy to scan and use. Do not use a generic one-size-fits-all
template when another structure would present the evidence better. Prefer
descriptive Markdown links over naked long URLs unless the raw URL itself is
meaningful.

The manifest has two evidence groups:
- records: completed records, each with metadata and the saves associated with it.
- unassigned: saved text/files/images that were not attached to a completed record.

Use both groups. Do not ignore unassigned saves; place them wherever they best
serve the task.`;

function buildReportMessage({ task, context, plan, status, result, error, evidence, evidenceSource, evidenceMode, rawTokens }) {
  const trustedContext = typeof context === 'string' && context.trim() ? context.trim() : '';
  const planBlock = typeof plan === 'string' && plan.trim() ? plan.trim() : '';
  return {
    role: 'user',
    content:
`Original task:
${task}
${trustedContext ? `\nTrusted context:\n${trustedContext}\n` : ''}${planBlock ? `\nThe agent's plan of action for this run — its intended approach and what this report was meant to contain. Use it to shape the report and to notice anything it called for that the evidence is missing; report only what the saved evidence actually supports:\n${planBlock}\n` : ''}

Run status: ${status || 'unknown'}
${result ? `\nFinal result:\n${result}\n` : ''}
${error ? `\nError:\n${error}\n` : ''}
Evidence source: ${evidenceSource || 'saved-manifest.json'}
Evidence mode: ${evidenceMode || 'manifest'}
Estimated evidence tokens: ${rawTokens ?? 'unknown'}

Saved evidence manifest:
${String(evidence || '').trim() || '(nothing saved)'}

Create report.md now.`,
  };
}

async function generateReport({ task, context, plan, status, result, error, evidence, evidenceSource, evidenceMode, rawTokens, provider, model, cacheKey, reasoningEffort, maxTokens, timeoutMs }) {
  const message = buildReportMessage({
    task,
    context,
    plan,
    status,
    result,
    error,
    evidence,
    evidenceSource,
    evidenceMode,
    rawTokens,
  });
  const completion = await callModel(
    { system: REPORT_SYSTEM, tools: [], messages: [message], model, cacheKey, reasoningEffort, maxTokens, timeoutMs },
    { provider }
  );
  const text = (completion.text || completion.refusal || '').trim();
  return { text, completion };
}

function quoteMarkdown(value) {
  return String(value || '').split(/\r?\n/).map(line => `> ${line}`).join('\n');
}

function fallbackReport(runArtifact, evidence, reason = null, { evidenceSource = 'saved-manifest.json' } = {}) {
  const out = [];
  out.push(`# Task\n${quoteMarkdown(runArtifact.task)}\n`);
  out.push(`## Result\n**Status:** ${runArtifact.status}\n`);
  if (runArtifact.result) out.push(`${runArtifact.result}\n`);
  if (runArtifact.error) out.push(`**Error:** ${runArtifact.error}\n`);
  if (reason) out.push(`**Report fallback:** ${reason}\n`);
  out.push(`## Saved Evidence (${evidenceSource})\n`);
  out.push(String(evidence || '').trim() || '_(nothing saved)_');
  out.push('');
  return out.join('\n');
}

module.exports = {
  generateReport,
  fallbackReport,
  buildReportMessage,
  REPORT_SYSTEM,
};
