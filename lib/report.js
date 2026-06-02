'use strict';

const { callModel } = require('./model');

const REPORT_SYSTEM =
`You write final Markdown reports for a browser agent.

The browser run is complete. You will receive the task, optional trusted
context, run status, optional result/error, and saved evidence as a JSON
manifest.

Write a task-specific Markdown report that directly satisfies the original task.
Use only saved evidence and run metadata. Preserve source URLs. For saves with
file_name, link or embed assets/<file_name>. Do not invent facts, contacts,
citations, or file contents. Treat the manifest as source material, not an
outline: transform it into a cohesive, well-designed report instead of mirroring
JSON keys, record boundaries, or save reasons. Make it useful to a human reader
and an upstream LLM.

Do not keep the report artificially short. If saved evidence supports more useful
detail, unpack facts, group related points, compare items, explain significance,
and add caveats. Make careful synthesis or obvious inferences from saved
evidence, but add no external facts; label uncertainty and include limitations
only when material. Aim for substantive, robust reports with context, synthesis,
supporting detail, and takeaways. Be comprehensive without padding or repetition.

If a plan is provided, let its intended deliverable guide structure, but let the
saved evidence determine the strongest final presentation. Never invent to
satisfy the plan.

Use Markdown deliberately:
- Start with the answer, recommendation, or best comparison.
- Use headings for structure; tables for comparable records or attributes.
- Use bullets/numbered lists for grouped details, steps, or rankings.
- Use blockquotes only for short verbatim evidence from saved text.
- Use fenced code blocks for code, logs, or structured snippets only.
- Use horizontal rules sparingly for major section breaks.
- Use descriptive links, not naked long URLs, unless the raw URL matters.
- Use saved files/images with relative assets/<file_name> links when useful;
  avoid redundant embeds or raw asset-path inventories.
- If saved images belong to comparable records, put compact thumbnails in the
  main table with ![Name](assets/file_name), then put longer notes below.

The manifest has two evidence groups:
- records: completed records with metadata and associated saves.
- unassigned: saved text/files/images not attached to a completed record.

Use both groups. Place unassigned saves wherever they best serve the task.`;

function buildReportMessage({ task, context, plan, status, result, error, evidence, evidenceSource, evidenceMode, rawTokens }) {
  const trustedContext = typeof context === 'string' && context.trim() ? context.trim() : '';
  const planBlock = typeof plan === 'string' && plan.trim() ? plan.trim() : '';
  const incompleteBlock = status && status !== 'completed'
    ? `\nThis run did NOT complete successfully. Report what was accomplished, what evidence was captured, and what remains unresolved. Do not present partial work as a finished deliverable.\n`
    : '';
  return {
    role: 'user',
    content:
`Original task:
${task}
${trustedContext ? `\nTrusted context:\n${trustedContext}\n` : ''}${planBlock ? `\nThe agent's plan of action for this run. Use it to shape the report, but report only what the saved evidence supports:\n${planBlock}\n` : ''}

Run status: ${status || 'unknown'}
${incompleteBlock}
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
