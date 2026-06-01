'use strict';

// Config-driven executor dispatcher. Selects a backend (os | cdp) and routes
// each Action to its verb handler. The backend owns dispatch mechanics;
// `executeAction` here owns the Observation envelope, settle, and errors.
//
// Usage:
//   const exec = createExecutor({ backend: 'os', humanize: { ... } });
//   await exec.init();                         // boots the Swift helper, etc.
//   const obs = await exec.execute(actions, session, brief);
//   await exec.close();
//
// See DESIGN.md § Verb contracts and § Settle contract.

const cdp = require('./executors/cdp');
const osExec = require('./executors/os');

const MAX_WAIT_MS = 30000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function buildBackend(opts) {
  const backend = opts.backend || (process.env.BROWSER_AGENT_EXECUTOR) || 'os';
  if (backend === 'os')  return osExec.create(opts);
  if (backend === 'cdp') return cdp;
  throw new Error(`unknown executor backend: ${backend}`);
}

function createExecutor(opts = {}, settleOpts = {}) {
  const backend = buildBackend(opts);
  let inited = false;

  async function init() {
    if (inited) return;
    await backend.init();
    inited = true;
  }

  async function close() {
    if (!inited) return;
    await backend.close();
    inited = false;
  }

  async function executeAction(action, session, brief) {
    const start = Date.now();
    const base = { kind: 'observation', verb: action.verb, ref: action.ref ?? null };

    try {
      if (action.verb === 'done') {
        // `done` never reaches a backend — it's a Loop-level signal. We
        // construct an ok Observation so it shows up in `steps` for the
        // history, but skip dispatch and skip settle.
        return { ...base, status: 'ok', error: null, elapsedMs: Date.now() - start, settleMs: 0 };
      }

      if (action.verb === 'save_text' || action.verb === 'save_record') {
        // Loop-level memory/ledger ops — no backend input, no page change. The
        // model authored both fields, so there's no extra LLM call: we hand them
        // to the loop as detail, which persists `content` to disk and re-injects
        // only `summary`. Skip dispatch and settle.
        const detail = {
          content: String(action.args?.content ?? ''),
          summary: String(action.args?.summary ?? ''),
        };
        return { ...base, status: 'ok', error: null, detail, elapsedMs: Date.now() - start, settleMs: 0 };
      }

      if (action.verb === 'wait') {
        const ms = action.args?.ms;
        if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) {
          throw new Error(`wait.ms must be a number from 0 to ${MAX_WAIT_MS}`);
        }
        await sleep(ms);
        const settleMs = await session.settle(settleOpts);
        return {
          ...base,
          status: 'ok',
          error: null,
          detail: { waitedMs: ms },
          elapsedMs: Date.now() - start,
          settleMs,
        };
      }

      const handler = backend[action.verb];
      if (!handler) throw new Error(`verb "${action.verb}" not implemented by backend "${backend.name}"`);

      // Spread `args` FIRST so handlers can destructure named params (e.g.
      // `text`), but the trusted envelope (`session`/`brief`/`ref`) wins — a
      // stray LLM-supplied arg named `session` or `brief` (validator tolerates
      // extras) must not be able to clobber the real bound values.
      const args = action.args || {};
      // Handlers may return a detail object (e.g. selectText returns the text it
      // selected) which we surface on the Observation for the event log.
      const detail = await handler({ ...args, session, brief, ref: action.ref });

      // Settle is universal infrastructure (see DESIGN.md § Settle contract).
      // Even fast-completing actions wait for the page to stop mutating, so
      // the next snapshot the LLM sees is consistent. settleOpts comes from the
      // run's config so a per-run settle override is actually honored.
      const settleMs = await session.settle(settleOpts);
      const detailField = detail && typeof detail === 'object' ? { detail } : {};
      return { ...base, status: 'ok', error: null, elapsedMs: Date.now() - start, settleMs, ...detailField };
    } catch (err) {
      // Fatal errors (e.g. the os backend detecting Chrome is no longer
      // frontmost) must end the run, not become a retryable failed step — the
      // loop would otherwise re-plan and dispatch the same input into whatever
      // app stole focus. Rethrow so run()'s catch marks the Run failed and exits.
      if (err && err.fatal) throw err;
      return {
        ...base,
        status: 'error',
        error: err?.message || String(err),
        elapsedMs: Date.now() - start,
        settleMs: 0,
      };
    }
  }

  async function execute(actions, session, brief) {
    if (!inited) await init();
    const observations = [];
    for (const action of actions) {
      const obs = await executeAction(action, session, brief);
      observations.push(obs);
      if (action.verb === 'done') break;
    }
    return observations;
  }

  return { init, close, execute, executeAction, backend };
}

module.exports = { createExecutor };
