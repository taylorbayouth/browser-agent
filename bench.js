#!/usr/bin/env node
'use strict';

// Benchmark harness. Runs a fixed task suite against the current provider/model,
// grades each result, and prints a Markdown-friendly table.
//
// Usage:
//   node bench.js
//   node bench.js --provider anthropic --model claude-opus-4-7
//   node bench.js --provider gemini --model gemini-3.1-pro
//   node bench.js --tasks wiki-shannon,hn-top
//
// Requires Chrome running on :9222 (npm run launch).
// Defaults to --executor cdp so no macOS driver or Accessibility permission is needed.

require('dotenv').config();

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');
const { loadConfig, deepMerge } = require('./lib/config');
const { navigate } = require('./lib/executors/page');

// ── Task suite ────────────────────────────────────────────────────────────────
// Each task: id, label, startUrl (where to navigate before the run), task (the
// agent instruction), grade(result, runArtifact) → boolean. grade may be omitted
// to use status === 'completed' as the only criterion.

const TASKS = [
  {
    id: 'wiki-shannon',
    label: 'Wikipedia: Shannon born',
    startUrl: 'https://en.wikipedia.org/wiki/Claude_Shannon',
    task: 'What year was Claude Shannon born? Return just the 4-digit year.',
    grade: (r) => r && r.includes('1916'),
  },
  {
    id: 'wiki-curie',
    label: 'Wikipedia: Curie born',
    startUrl: 'https://en.wikipedia.org/wiki/Marie_Curie',
    task: 'What year was Marie Curie born? Return just the 4-digit year.',
    grade: (r) => r && r.includes('1867'),
  },
  {
    id: 'wiki-berners-lee',
    label: 'Wikipedia: Berners-Lee born',
    startUrl: 'https://en.wikipedia.org/wiki/Tim_Berners-Lee',
    task: 'What year was Tim Berners-Lee born? Return just the 4-digit year.',
    grade: (r) => r && r.includes('1955'),
  },
  {
    id: 'hn-top',
    label: 'Hacker News: #1 story title',
    startUrl: 'https://news.ycombinator.com/',
    task: 'Return the title of the #1 story on Hacker News right now.',
    grade: (r, a) => a.status === 'completed' && r && r.length > 5,
  },
  {
    id: 'github-react',
    label: 'GitHub: React description',
    startUrl: 'https://github.com/facebook/react',
    task: 'What is the short one-line description of the facebook/react GitHub repository? Return just that description.',
    grade: (r) => r && /react|ui|interface|web/i.test(r),
  },
];

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { provider: null, model: null, tasks: null, executor: 'cdp' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider' || a === '-p') args.provider = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--tasks') args.tasks = argv[++i]?.split(',');
    else if (a === '--executor') args.executor = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node bench.js [options]

Options:
  --provider, -p <name>    LLM provider: openai | anthropic | gemini | ollama
  --model <id>             Override the provider's default model
  --tasks <ids>            Comma-separated task IDs to run (default: all)
  --executor <cdp|os>      Input backend (default: cdp)
  --help, -h               Show this help

Available task IDs: ${TASKS.map(t => t.id).join(', ')}`);
      process.exit(0);
    }
  }
  return args;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function pad(s, n) { return String(s).slice(0, n).padEnd(n); }
function rpad(s, n) { return String(s).padStart(n); }
function fmtN(n) { return (n || 0).toLocaleString(); }
function fmtMs(ms) { return (ms / 1000).toFixed(1) + 's'; }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const override = { executor: { backend: args.executor } };
  if (args.provider) override.provider = args.provider;
  if (args.model) override.model = args.model;
  const config = deepMerge(loadConfig(), override);

  const tasks = args.tasks
    ? TASKS.filter(t => args.tasks.includes(t.id))
    : TASKS;

  if (!tasks.length) {
    console.error('No tasks matched. IDs: ' + TASKS.map(t => t.id).join(', '));
    process.exit(1);
  }

  const providerLabel = `${config.models.primary.provider}${config.models.primary.model ? '/' + config.models.primary.model : ''}`;
  console.error(`browser-agent bench — ${tasks.length} task(s) · ${providerLabel} · executor: ${config.executor.backend}\n`);

  let session;
  try {
    session = await connect({ port: 9222 });
  } catch (err) {
    console.error(`Cannot connect to Chrome on :9222. Start Chrome first:\n  npm run launch\nError: ${err.message}`);
    process.exit(1);
  }

  const results = [];

  for (const task of tasks) {
    console.error(`── ${task.label}`);

    try {
      await navigate({ session, url: task.startUrl });
    } catch (err) {
      console.error(`   nav failed: ${err.message}`);
      results.push({ task, status: 'nav-error', passed: false });
      continue;
    }

    let artifact;
    try {
      artifact = await run({ session, task: task.task, config });
    } catch (err) {
      console.error(`   run failed: ${err.message}`);
      results.push({ task, status: 'run-error', passed: false });
      continue;
    }

    const grade = task.grade ?? ((_r, a) => a.status === 'completed');
    const passed = grade(artifact.result, artifact);
    const s = artifact.stats;
    const totalCacheRead = artifact.completions.reduce((acc, c) => acc + (c.usage?.cacheReadTokens || 0), 0);
    const cachePct = s.totalInputTokens ? Math.round(totalCacheRead / s.totalInputTokens * 100) : 0;

    results.push({ task, status: artifact.status, passed, steps: s.stepCount,
      elapsedMs: s.totalElapsedMs, inputTokens: s.totalInputTokens,
      outputTokens: s.totalOutputTokens, cachePct, result: artifact.result });

    const mark = passed ? '✓' : '✗';
    const snippet = artifact.result ? artifact.result.slice(0, 60) : artifact.status;
    console.error(`   ${mark} ${snippet}`);
  }

  await session.close();

  // ── Results table ──────────────────────────────────────────────────────────

  const widths = [28, 11, 5, 6, 8, 7, 7, 4];
  const cols   = ['Task', 'Status', 'Steps', 'Time', 'In', 'Out', 'Cache%', 'Pass'];
  const line   = widths.map(w => '-'.repeat(w)).join('  ');

  console.log(`\n## Benchmark\n`);
  console.log(`Provider: ${providerLabel}  Executor: ${config.executor.backend}\n`);
  console.log(cols.map((c, i) => pad(c, widths[i])).join('  '));
  console.log(line);

  let passed = 0;
  for (const r of results) {
    const row = [
      pad(r.task.label, widths[0]),
      pad(r.status ?? 'error', widths[1]),
      rpad(r.steps ?? '-', widths[2]),
      rpad(r.elapsedMs ? fmtMs(r.elapsedMs) : '-', widths[3]),
      rpad(r.inputTokens ? fmtN(r.inputTokens) : '-', widths[4]),
      rpad(r.outputTokens ? fmtN(r.outputTokens) : '-', widths[5]),
      rpad(r.cachePct != null ? r.cachePct + '%' : '-', widths[6]),
      r.passed ? '✓' : '✗',
    ];
    console.log(row.join('  '));
    if (r.passed) passed++;
  }

  console.log(line);
  console.log(`\n${passed}/${results.length} passed\n`);

  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(err => {
  console.error('fatal:', err?.message || err);
  process.exit(1);
});
