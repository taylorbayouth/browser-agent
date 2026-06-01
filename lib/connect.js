'use strict';

const CDP = require('chrome-remote-interface');
const { getTarget, isControllablePageTarget } = require('./launch');
const { performExtract } = require('./extract');
const { loadConfig } = require('./config');

// Pure tab-following policy. Given the live page targets and what we last saw,
// decide which target the session should pin to — returns a targetId, or null
// to stay put. Deterministic and cross-platform: it reads CDP's own target
// graph (openerId) instead of guessing from OS window focus.
//
//   - current tab still open, and it opened a child (openerId === current):
//     follow the newest child. window.open tabs keep openerId so the child can
//     communicate back to its opener — follow regardless of allowFresh.
//   - current still open, no child, but a brand-new target appeared since last
//     poll (e.g. target=_blank rel=noopener, which severs openerId): follow it,
//     but ONLY right after we acted (allowFresh) and once we have a baseline — so
//     neither the first poll nor a tab the USER opens during idle polling yanks
//     the session away.
//   - current tab gone (popup/tab closed): return to its opener if still around,
//     else the newest remaining page.
function chooseTab({ pages, currentId, openerId, knownIds, allowFresh = true }) {
  pages = (pages || []).filter(isControllablePageTarget);
  if (!pages.length) return null;
  const current = pages.find(p => p.targetId === currentId);
  if (current) {
    const children = pages.filter(p => p.openerId === currentId);
    if (children.length) return children[children.length - 1].targetId;
    // A brand-new tab with no openerId link (target=_blank rel=noopener severs it).
    // Such a tab is opened by a click, so it surfaces on the very next post-action
    // extract — follow it only then (allowFresh). During idle no-change polling
    // allowFresh is false, so a background tab the user opens mid-wait can't steal
    // the session. (window.open tabs keep openerId and follow via the child path
    // above regardless of allowFresh.)
    if (allowFresh && knownIds && knownIds.size) {
      const fresh = pages.filter(p => p.targetId !== currentId && !knownIds.has(p.targetId));
      if (fresh.length) return fresh[fresh.length - 1].targetId;
    }
    return null;
  }
  const opener = openerId && pages.find(p => p.targetId === openerId);
  return (opener || pages[pages.length - 1]).targetId;
}

function isConnectionError(err) {
  const msg = err?.message || '';
  return (
    msg.includes('WebSocket') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ECONNRESET'
  );
}

class Session {
  constructor(client, target, opts) {
    this._client = client;
    this._target = target;
    this._opts = opts;
    this._axEnabled = false;
    // Tab-following state (see chooseTab + followActiveTab): the targets we've
    // seen so far, and the opener of the tab we're currently pinned to.
    this._knownTargetIds = new Set();
    this._openerId = null;
  }

  // Raw CDP client for power users who need direct protocol access.
  get client() { return this._client; }

  async _ensureAxEnabled() {
    if (!this._axEnabled) {
      await this._client.Accessibility.enable();
      this._axEnabled = true;
    }
  }

  async _reconnect() {
    try { await this._client.close(); } catch {}
    this._axEnabled = false;
    const port = this._opts.port || 9222;
    // Prefer re-attaching to the current target id — followActiveTab may have
    // moved the session onto a popup or new tab, making opts.url a stale selector
    // that either throws "no tab found" or silently snaps back to the wrong tab.
    // Only fall back to getTarget(opts) if the current target is truly gone.
    let target;
    try {
      const live = await CDP.List({ port });
      target = live.find(t => t.id === this._target.id) ?? await getTarget(this._opts);
    } catch {
      target = await getTarget(this._opts);
    }
    this._target = target;
    this._client = await CDP({ target, port });
    // Reset the tab-following baseline to mirror a fresh connect: a reconnect may
    // land on a different target, so a stale openerId / knownIds set would mis-pin
    // or make the next poll treat pre-existing tabs as "fresh".
    this._openerId = null;
    this._knownTargetIds = new Set();
    await this._ensureAxEnabled();
  }

  // Re-pin the session to the tab where the last action actually landed. A click
  // that opens a new tab leaves the CDP session bound to the original tab, so
  // every later extract reads a stale page. We read the live target graph
  // (Target.getTargets exposes openerId) and let chooseTab decide where to go.
  // Returns true if it switched.
  async followActiveTab(allowFresh = true) {
    const port = this._opts.port || 9222;
    let infos;
    try {
      ({ targetInfos: infos } = await this._client.Target.getTargets());
    } catch {
      return false;
    }
    const pages = (infos || []).filter(isControllablePageTarget);
    const currentId = this._target.id;
    const desiredId = chooseTab({ pages, currentId, openerId: this._openerId, knownIds: this._knownTargetIds, allowFresh });
    if (process.env.BROWSER_AGENT_DEBUG_TABS) {
      const all = (infos || []).map(t => `${t.type}:${(t.url || '').slice(0, 40)}${t.targetId === currentId ? '*' : ''}${this._knownTargetIds.has(t.targetId) ? '' : '+'}${t.openerId ? `<${t.openerId.slice(0, 6)}` : ''}`);
      console.error(`[tabs] allowFresh=${allowFresh} current=${currentId.slice(0, 6)} desired=${desiredId ? desiredId.slice(0, 6) : 'stay'} | ${all.join('  ')}`);
    }
    // Refresh the baseline every poll so "appeared since last time" stays honest.
    this._knownTargetIds = new Set(pages.map(p => p.targetId));

    if (!desiredId || desiredId === currentId) return false;
    const desired = pages.find(p => p.targetId === desiredId);

    // Establish the new connection before tearing down the old one. The desired
    // tab (often a short-lived popup) may have vanished in the window
    // between getTargets and CDP() — if connect throws, stay on the current tab
    // rather than leaving the session holding a closed client.
    let newClient;
    try {
      newClient = await CDP({ target: desiredId, port });
    } catch {
      // The baseline rebuild above already recorded desiredId as "seen", so a
      // transient connect failure (a tab chooseTab picked but couldn't attach to)
      // would otherwise leave it stuck in knownIds and never look "fresh" again.
      // Drop it so the next poll can retry instead of stranding it.
      this._knownTargetIds.delete(desiredId);
      return false;
    }

    try { await this._client.close(); } catch {}
    this._axEnabled = false;
    this._openerId = desired.openerId || null;
    this._target = { id: desired.targetId, url: desired.url, title: desired.title, type: desired.type };
    this._client = newClient;
    await this._ensureAxEnabled();
    return true;
  }

  async extract(opts = {}) {
    const mergedOpts = { ...this._opts, ...opts };
    await this._ensureAxEnabled();
    let result;
    try {
      result = await performExtract(this._client, mergedOpts);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      await this._reconnect();
      result = await performExtract(this._client, mergedOpts);
    }
    // Refresh url/title from the live target rather than the connect-time
    // snapshot — an in-page navigation changes them, which would otherwise
    // leave every brief reporting the original URL (and feed a stale value
    // into briefHash). Out-of-page (no Runtime.evaluate), so the no-footprint
    // guarantee holds. Falls back to the cached target on any error.
    const { url, title } = await this._currentUrlTitle();
    result.url = url;
    result.title = title;
    return result;
  }

  async _currentUrlTitle() {
    try {
      const { targetInfo } = await this._client.Target.getTargetInfo({ targetId: this._target.id });
      if (targetInfo) {
        this._target.url = targetInfo.url;
        this._target.title = targetInfo.title;
        return { url: targetInfo.url, title: targetInfo.title };
      }
    } catch {}
    return { url: this._target.url, title: this._target.title };
  }

  // Brief pause after an action so the next snapshot isn't taken mid-mutation.
  // This is deliberately small — the loop's change-polling (see lib/loop.js,
  // controlled by config.loop.pollMs) does the real "wait until the page
  // actually changes" work. Defaults come from config.settle; opts override.
  async settle(opts = {}) {
    const cfg = loadConfig().settle;
    const start = Date.now();
    const afterActionMs = opts.afterActionMs ?? cfg.afterActionMs;
    const maxMs = opts.maxMs ?? cfg.maxMs;
    await new Promise(r => setTimeout(r, Math.min(afterActionMs, maxMs)));
    return Date.now() - start;
  }

  async close() {
    if (this._client) {
      try { await this._client.close(); } catch {}
      this._client = null;
    }
  }
}

async function connect(opts = {}) {
  const target = await getTarget(opts);
  const client = await CDP({ target, port: opts.port || 9222 });
  return new Session(client, target, opts);
}

module.exports = { connect, Session, chooseTab, isConnectionError };
