'use strict';

const { callModel } = require('./model');
const { estimateTokens } = require('./tokens');

const DEFAULT_RAW_TOKEN_BUDGET = 3000;

const REPORT_SYSTEM =
`You write final Markdown reports for a browser agent.

The browser run is complete. You will receive the task, optional trusted context,
run status, optional final result/error, and the saved evidence captured during
browsing.

Write a task-specific Markdown report that directly satisfies the task. Use only
and all of the saved evidence and provided run metadata. Preserve source URLs and relative
asset links exactly. Do not invent facts, contacts, citations, or file contents.
If the saved evidence is incomplete, say what is missing. Keep the report useful
to both an upstream LLM and a human reader.

Let the task's intended deliverable guide the report's structure, and check the
evidence against what the task set out to capture — but never invent to fill a
gap; note what the task called for that the run did not actually produce.

Think deeply about the best layout for this specific task and evidence. Choose
headings, tables, grouped sections, bullets, image/file embeds, and link labels
that make the data easy to scan and use. Do not use a generic one-size-fits-all
template when another structure would present the evidence better. Prefer descriptive Markdown links over naked long URLs unless the raw URL itself is meaningful.
Turn raw capture labels into reader-facing prose when the meaning is clear. For
example, "URL: https://example.test Reason: Save Acme contacts" can become
"Save Acme contacts: https://example.test", and repeated lines like
"Name — title" or "Company: detail" should usually become proper Markdown
bullets, tables, or definition-style groups. Keep this guidance general: do not
force every record into these examples, but look for obvious separators,
repeated shapes, and provenance fields that can be formatted more cleanly.

If the evidence source is saved.md, write a comprehensive report from the raw
saved evidence and do not leave out saved records, URLs, files, images, or
important details. If the evidence source is saved-index.md, write a summary
report: organize the indexed records, preserve the useful URLs/assets, and be
explicit that raw details remain in saved.md.`;

function buildReportMessage({ task, context, status, result, error, evidence, evidenceSource, evidenceMode, rawTokens, rawTokenBudget }) {
  const trustedContext = typeof context === 'string' && context.trim() ? context.trim() : '';
  return {
    role: 'user',
    content:
`Task:
${task}
${trustedContext ? `\nTrusted context:\n${trustedContext}\n` : ''}
Run status: ${status || 'unknown'}
${result ? `\nFinal result:\n${result}\n` : ''}
${error ? `\nError:\n${error}\n` : ''}
Evidence source: ${evidenceSource || 'saved.md'}
Evidence mode: ${evidenceMode || 'full'}
Estimated saved.md tokens: ${rawTokens ?? 'unknown'}
Raw evidence budget: ${rawTokenBudget ?? DEFAULT_RAW_TOKEN_BUDGET}

Saved evidence:
${String(evidence || '').trim() || '(nothing saved)'}

Create report.md now.`,
  };
}

function selectReportEvidence({ saved, index, rawTokenBudget = DEFAULT_RAW_TOKEN_BUDGET } = {}) {
  const budget = Number(rawTokenBudget) > 0 ? Number(rawTokenBudget) : DEFAULT_RAW_TOKEN_BUDGET;
  const rawTokens = estimateTokens(saved || '');
  const hasIndex = String(index || '').trim().length > 0;
  if (rawTokens > budget && hasIndex) {
    return {
      source: 'saved-index.md',
      mode: 'summary-index',
      content: index,
      rawTokens,
      rawTokenBudget: budget,
    };
  }
  return {
    source: 'saved.md',
    mode: 'full-raw',
    content: saved,
    rawTokens,
    rawTokenBudget: budget,
  };
}

async function generateReport({ task, context, status, result, error, evidence, evidenceSource, evidenceMode, rawTokens, rawTokenBudget, provider, model, cacheKey, reasoningEffort, maxTokens, timeoutMs }) {
  const message = buildReportMessage({
    task,
    context,
    status,
    result,
    error,
    evidence,
    evidenceSource,
    evidenceMode,
    rawTokens,
    rawTokenBudget,
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

function fallbackReport(runArtifact, evidence, reason = null, { evidenceSource = 'saved.md' } = {}) {
  const out = [];
  out.push(`# Task\n${quoteMarkdown(runArtifact.task)}\n`);
  out.push(`## Result\n**Status:** ${runArtifact.status}\n`);
  if (runArtifact.result) out.push(`${runArtifact.result}\n`);
  if (runArtifact.error) out.push(`**Error:** ${runArtifact.error}\n`);
  if (reason) out.push(`**Report fallback:** ${reason}\n`);
  out.push(evidenceSource === 'saved.md' ? '## Saved Evidence\n' : `## Saved Evidence (${evidenceSource})\n`);
  out.push(String(evidence || '').trim() || '_(nothing saved)_');
  out.push('');
  return out.join('\n');
}

module.exports = {
  generateReport,
  fallbackReport,
  buildReportMessage,
  selectReportEvidence,
  REPORT_SYSTEM,
  DEFAULT_RAW_TOKEN_BUDGET,
};
