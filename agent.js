#!/usr/bin/env node
'use strict';

require('dotenv').config({ quiet: true });

const { pathToFileURL } = require('url');

// Single entry point. Runs preflight (deps, driver, Accessibility, creds,
// Chrome), then an agent loop against the current tab, and prints the Run
// artifact as JSON. The task and flags you pass are the agent's instructions.
//
// Usage:
//   OPENAI_API_KEY=...    node agent.js "search for hello world"
//   ANTHROPIC_API_KEY=... node agent.js --provider anthropic "..."
//   GEMINI_API_KEY=...    node agent.js --provider gemini "..."
//   node agent.js --provider ollama --model-id llama3.1 "..."
//
// Preflight launches Chrome if it isn't already running; just navigate the tab
// to whatever page the task expects.

const { connect } = require('./lib/connect');
const { run } = require('./lib/loop');
const { loadConfig, deepMerge, ConfigError } = require('./lib/config');
const { preflight, PreflightError } = require('./lib/preflight');
const { providers } = require('./lib/providers');

const PROVIDERS = new Set(Object.keys(providers));
const EXECUTORS = new Set(['os', 'cdp']);
const KNOWN_OPTIONS = new Set(['--task', '-t', '--provider', '-p', '--model-id', '--context', '-c', '--executor', '--show-report', '--help', '-h']);

function usageError(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

// Parse CLI flags into a partial config override. Only keys actually passed are
// set (everything else stays undefined), so deepMerge leaves config-file values
// intact for unspecified flags.
function parseArgs(argv) {
  const args = { task: null };
  const override = { executor: {} };
  const positional = [];

  const value = (argv, i, flag) => {
    const raw = argv[i + 1];
    if (raw === undefined || KNOWN_OPTIONS.has(raw)) usageError(`${flag} requires a value`);
    return raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task' || a === '-t') args.task = value(argv, i++, a);
    else if (a === '--provider' || a === '-p') { ((override.models ??= {}).primary ??= {}).provider = value(argv, i++, a); }
    else if (a === '--model-id') { ((override.models ??= {}).primary ??= {}).model = value(argv, i++, a); }
    else if (a === '--context' || a === '-c') override.context = value(argv, i++, a);
    else if (a === '--executor') override.executor.backend = value(argv, i++, a);
    else if (a === '--show-report') args.showReport = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a.startsWith('-')) usageError(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (args.task && positional.length) {
    usageError('pass the task once: --task "..." or positional words, not both');
  }
  if (!args.task && positional.length) args.task = positional.join(' ');
  args.override = override;
  return args;
}

function printHelp() {
  console.log(`Usage: node agent.js [options] <task>

All knobs live in browser-agent.config.json. CLI flags below override the file.

Options:
  --task, -t <string>          The task for the agent (or pass as positional)
  --provider, -p <name>        LLM provider: ${[...PROVIDERS].join(' | ')}
  --model-id <id>              Override the provider's default model
  --context, -c <string>       Trusted background for the agent (user info,
                               preferences). Injected at the end of the system
                               prompt. Omit for none.
  --executor <os|cdp>          Input backend. Default 'os' uses browser-input (macOS).
  --show-report                After a successful run, open report.html in a
                               new browser tab.
  --help, -h                   Show this help

Config file:
  browser-agent.config.json       All defaults; CLI flags override. Path override:
                               BROWSER_AGENT_CONFIG.

Environment:
  OPENAI_API_KEY          Required for the openai provider (the default).
  ANTHROPIC_API_KEY       Required for the anthropic provider.
  GEMINI_API_KEY          Required for the gemini provider.
  BROWSER_AGENT_PROVIDER     Override config provider (${[...PROVIDERS].join('|')}).
  BROWSER_AGENT_EXECUTOR     Override config executor backend ('os'|'cdp').
  BROWSER_AGENT_CHROME_PATH  Explicit Chrome/Chromium executable path.
  BROWSER_AGENT_CONTEXT      Trusted background injected into the system prompt.
  OPENAI_PROMPT_CACHE_RETENTION  Optional OpenAI cache retention ('24h' for
                          extended retention on supported models; unset = default).
  OLLAMA_KEEP_ALIVE       Optional: keep the Ollama model + KV cache loaded
                          ('30m', seconds, or '-1' for forever; unset = 5m).`);
}

function validateConfig(config) {
  const primaryProvider = config.models?.primary?.provider;
  if (!PROVIDERS.has(primaryProvider)) {
    usageError(`unknown provider "${primaryProvider}" (expected: ${[...PROVIDERS].join(', ')})`);
  }
  const backend = config.executor?.backend;
  if (!EXECUTORS.has(backend)) {
    usageError(`unknown executor "${backend}" (expected: ${[...EXECUTORS].join(', ')})`);
  }
  // Numeric loop knobs must be sane. A bad value from the config file otherwise
  // fails silently and weirdly: maxSteps <= 0 exits before the first turn; a
  // negative pollMs makes the no-change wait never elapse.
  const posInt = (v, name) => {
    if (!Number.isInteger(v) || v <= 0) usageError(`${name} must be a positive integer, got ${v}`);
  };
  posInt(config.loop?.maxSteps, 'loop.maxSteps');
  posInt(config.loop?.pollMs, 'loop.pollMs');
  // The dead-loop guards (see lib/loop.js): a non-positive value here would
  // silently weaken or disable stuck/empty-plan/no-change detection.
  posInt(config.loop?.maxNoChangePolls, 'loop.maxNoChangePolls');
  posInt(config.loop?.maxStuckRepeats, 'loop.maxStuckRepeats');
  posInt(config.loop?.maxEmptyPlans, 'loop.maxEmptyPlans');
}

async function showReport(session, reportHtmlPath) {
  if (!session?.client || !reportHtmlPath) return;
  const url = pathToFileURL(reportHtmlPath).href;
  const { targetId } = await session.client.Target.createTarget({
    url,
    newWindow: false,
  });
  if (targetId) await session.client.Target.activateTarget?.({ targetId });
}

function buildHandoff(runArtifact, config = {}) {
  const artifacts = runArtifact.artifacts || {};
  const context = typeof config.context === 'string' && config.context.trim()
    ? config.context.trim()
    : null;
  const error = runArtifact.error
    ? { message: runArtifact.error, type: runArtifact.errorType || null }
    : null;
  return {
    ok: runArtifact.status === 'completed',
    status: runArtifact.status,
    runId: runArtifact.id,
    task: runArtifact.task,
    context,
    plan: runArtifact.plan ?? null,
    result: runArtifact.result ?? null,
    report: {
      markdown: runArtifact.report ?? null,
      path: artifacts.reportPath || null,
      htmlPath: artifacts.reportHtmlPath || null,
      evidenceSource: runArtifact.reportEvidence?.source || null,
      rawTokens: runArtifact.reportEvidence?.rawTokens ?? null,
    },
    artifacts: {
      runDir: artifacts.runDir || null,
      savedManifest: artifacts.savedManifestPath || null,
      assetsDir: artifacts.assetsDir || null,
      log: artifacts.logPath || null,
      jsonl: artifacts.jsonlPath || null,
    },
    stats: {
      steps: runArtifact.stats?.stepCount ?? 0,
      elapsedMs: runArtifact.stats?.totalElapsedMs ?? 0,
      inputTokens: runArtifact.stats?.totalInputTokens ?? 0,
      outputTokens: runArtifact.stats?.totalOutputTokens ?? 0,
      estimatedPromptTokens: runArtifact.stats?.totalEstimatedPromptTokens ?? 0,
    },
    error,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    console.error('error: no task provided (use --task "..." or a positional argument)');
    printHelp();
    process.exit(2);
  }

  // Final config: DEFAULTS < file < env (all from loadConfig) < CLI flags.
  let config;
  try {
    config = deepMerge(loadConfig(), args.override);
  } catch (err) {
    if (err instanceof ConfigError) usageError(err.message);
    throw err;
  }
  validateConfig(config);
  // Preflight gets the environment ready (and launches Chrome). Its errors are
  // user-facing setup guidance, so print them plainly without a stack trace.
  let port = 9222;
  try {
    port = await preflight({ config, port });
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  let session;
  try {
    session = await connect({ port });
    const runArtifact = await run({ session, task: args.task, config });
    if (args.showReport && runArtifact.status === 'completed' && runArtifact.artifacts?.reportHtmlPath) {
      await showReport(session, runArtifact.artifacts.reportHtmlPath);
    }
    process.stdout.write(JSON.stringify(buildHandoff(runArtifact, config)) + '\n');
    process.exitCode = runArtifact.status === 'completed' ? 0 : 1;
  } finally {
    if (session) await session.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('fatal:', err?.message || err);
    process.exit(1);
  });
}

module.exports = { buildHandoff, parseArgs, showReport };
