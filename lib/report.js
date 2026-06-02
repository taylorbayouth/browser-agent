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

Do not keep the report artificially short. If saved evidence supports more useful
detail, include it by unpacking facts, grouping related points, comparing items,
explaining significance, and adding caveats. You may make careful synthesis or
obvious inferences from saved evidence, but do not add external facts; label
uncertain conclusions and separate gaps from supported findings. Be
comprehensive without padding or repeating the same point.

If the agent's plan of action is provided, let its intended deliverable guide the
report's structure, and check the evidence against what the plan set out to
capture — but never invent to fill a gap; note what the plan called for that the
run did not actually produce.

Use Markdown deliberately:
- Start with the answer, recommendation, or best comparison.
- Use headings for structure; use tables for comparable records or attributes.
- Use bullet or numbered lists for short grouped details, steps, or rankings.
- Use blockquotes only for short verbatim evidence from saved text.
- Use fenced code blocks only for code, logs, or structured snippets.
- Use horizontal rules sparingly to separate major report sections.
- Use descriptive links, not naked long URLs, unless the raw URL matters.
- Embed saved files and images with relative assets/<file_name> links.
- If saved images belong to comparable records, put compact thumbnails in the
  main table with ![Name](assets/file_name), then put longer notes below.

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
