'use strict';

// OS executor — drives the real mouse cursor and keyboard via a long-lived
// `browser-input` native helper. Input is posted at the OS layer (CGEventPost
// on macOS, XTEST on Linux/X11), so in-page JS sees `isTrusted: true` events
// with real timing and (when configured) humanlike motion. This is the path
// designed to avoid bot detection.
//
// Requires:
//   - macOS, or Linux running an X11 / Xwayland session (native Wayland is not
//     supported — XTEST is a no-op there; use the cdp executor instead)
//   - The `browser-input` binary, built once via the platform's build.sh under
//     native/<macos|linux>/browser-input/build.sh
//   - macOS only: Accessibility permission for the calling process (Terminal,
//     Node, etc.) in System Settings → Privacy & Security → Accessibility
//
// Both helpers speak the same protocol — newline-delimited JSON over
// stdin/stdout — so everything below is platform-agnostic.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  ensureInView, navigate, back, clickablePoint, isTextInput,
  normalizeUrl, waitForLoad, waitForNetworkIdle,
} = require('./page');
const { screenshot: captureScreenshot } = require('../screenshot');
const { saveFile } = require('../savefile');
const { getFiles } = require('../media');

const PLATFORM_BIN = {
  darwin: path.resolve(__dirname, '..', '..', 'native', 'macos',  'browser-input', 'bin', 'browser-input'),
  linux:  path.resolve(__dirname, '..', '..', 'native', 'linux',  'browser-input', 'bin', 'browser-input'),
};
const DEFAULT_BIN = PLATFORM_BIN[process.platform] || PLATFORM_BIN.darwin;

const DEFAULT_HUMANIZE = {
  enabled: true,
  mouseSpeedPxPerSec: 1400,
  mouseJitterPx: 2,
  keystrokeDelayMsMin: 25,
  keystrokeDelayMsMax: 85,
  postFocusPauseMs: 80,
  postClearPauseMs: 50,
  preClickPauseMsMin: 40,
  preClickPauseMsMax: 160,
  scrollDurationMs: 400,
  scrollJitterPx: 3,
  typeOmnibox: true,
};

// Cursor lands roughly this many CSS pixels above the viewport top — i.e. over
// Chrome's address bar. The omnibox lives in browser chrome whose exact height
// varies (bookmarks bar, zoom, fullscreen); this is a look-right aim point that
// never clicks, so an approximate inset is all it needs.
const OMNIBOX_INSET_PX = 38;
// Min wait after Cmd+L before the first character is typed. The Cmd modifier
// release races the next keystroke in the input queue — too short and the first
// "h" of "https" arrives while Cmd is still held, triggering Cmd+H/Cmd+T. The
// old removed implementation used 200ms total but typed at 12–25ms gaps,
// leaving headroom for the chord race; we use 200ms here AND keep the type op
// at humanize.keystrokeDelayMsMin/Max (25–85ms) so the first char never races.
const POST_CMDL_PAUSE_MS = 200;

function mergeHumanize(opts) {
  return { ...DEFAULT_HUMANIZE, ...(opts || {}) };
}

function bboxArrToObj(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

// click and select_text target text (@t) or element (@e) refs, so look in both.
function nodeByRef(brief, ref) {
  return brief.elements?.find(n => n.ref === ref)
    ?? brief.text?.find(n => n.ref === ref)
    ?? null;
}

// Chrome identifiers per platform. The macOS helper returns bundleId; the
// Linux helper returns wmClass. frontmostApp() normalises to one field.
const CHROME_BUNDLES = new Set([
  // macOS bundle IDs
  'com.google.Chrome', 'com.google.Chrome.beta', 'com.google.Chrome.dev',
  'com.google.Chrome.canary', 'org.chromium.Chromium',
  // Linux WM_CLASS strings (res_class, as reported by xprop WM_CLASS)
  'Google-chrome', 'Google-chrome-beta', 'Google-chrome-unstable',
  'Chromium', 'Chromium-browser',
]);

// Hard safety gate for the OS backend. CGEvents land on whatever app is in the
// foreground, so if focus has left Chrome — the user alt-tabbed, a dialog stole
// focus, Chrome was minimized — sending a click/keystroke/drag would act on
// some *other* app. We wait until Chrome is foreground again before continuing.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function frontmostApp(client) {
  try {
    const info = await client.send({ op: 'frontapp' });
    // Normalise: Linux helper returns wmClass; Mac returns bundleId. Expose
    // both as bundleId so the CHROME_BUNDLES check below works unchanged.
    if (info && !info.bundleId && info.wmClass) info.bundleId = info.wmClass;
    return info;
  } catch (err) {
    const e = new Error(`aborted: could not confirm Chrome is frontmost (${err.message}); refusing to send OS input`);
    e.fatal = true;
    throw e;
  }
}

// Returns ms since the user last touched the real mouse/keyboard, or null if the
// helper can't report it (e.g. an older browser-input binary without the `idle`
// op). The helper subtracts the agent's own injected events, so this reflects
// the human only. null ⇒ caller should not block (fail open).
async function userIdleMs(client) {
  try {
    const state = await client.send({ op: 'idle' });
    const ms = state?.userIdleMs;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// The input safety gate. CGEvents land on whatever app is frontmost and whoever
// happens to be holding the mouse — so before sending any input we wait until
// BOTH are true: (1) Chrome is the foreground app, and (2) the human isn't
// actively using the machine. Either failing pauses (polling) and auto-resumes
// when it clears, so a user testing on their own machine can grab the mouse and
// the agent backs off instead of fighting them. With wait:false the gate aborts
// instead of pausing (used where blocking the loop would be wrong).
async function ensureInputSafe(client, opts = {}) {
  const wait = opts.wait !== false;
  const pollMs = Math.max(100, opts.pollMs ?? 500);
  const idle = client.idleGuard || { enabled: false, thresholdMs: 0 };
  // Bound how long we'll pause for Chrome to come back. A brief alt-tab resolves
  // well within this; staying non-frontmost for the whole window means Chrome
  // quit/crashed — pausing forever would hang the run, so we end it cleanly
  // (fatal). 0/unset disables the deadline (pause indefinitely, the old behavior).
  const frontmostTimeoutMs = Number.isFinite(client.frontmostTimeoutMs) ? client.frontmostTimeoutMs : 0;
  let notFrontSince = null;
  let announcedFront = false;
  let announcedIdle = false;

  for (;;) {
    // Gate 1 — Chrome must be frontmost.
    const info = await frontmostApp(client);
    if (!CHROME_BUNDLES.has(info?.bundleId)) {
      const front = info?.name || info?.bundleId || 'unknown';
      if (!wait) {
        const e = new Error(`aborted: Chrome is not the frontmost app (foreground: ${front}); refusing to send OS-level input to another application`);
        e.fatal = true;
        throw e;
      }
      if (frontmostTimeoutMs > 0) {
        notFrontSince = notFrontSince ?? Date.now();
        if (Date.now() - notFrontSince > frontmostTimeoutMs) {
          const e = new Error(`aborted: Chrome has not been frontmost for ${Math.round(frontmostTimeoutMs / 1000)}s (foreground: ${front}); it likely quit or crashed`);
          e.fatal = true;
          throw e;
        }
      }
      if (!announcedFront) {
        console.error(`[os] Chrome is not frontmost (foreground: ${front}); pausing until Chrome returns to the foreground.`);
        announcedFront = true;
      }
      await sleep(pollMs);
      continue;
    }
    notFrontSince = null;   // Chrome is back — reset the deadline
    if (announcedFront) console.error('[os] Chrome is frontmost again; resuming.');
    announcedFront = false;

    // Gate 2 — the human must not be actively using the mouse/keyboard.
    if (idle.enabled) {
      const ms = await userIdleMs(client);
      if (ms !== null && ms < idle.thresholdMs) {
        if (!wait) {
          const e = new Error(`aborted: user is actively using the machine (idle ${ms}ms < ${idle.thresholdMs}ms); refusing to send OS-level input`);
          e.fatal = true;
          throw e;
        }
        if (!announcedIdle) {
          console.error(`[os] user is active (idle ${ms}ms < ${idle.thresholdMs}ms); pausing until you stop.`);
          announcedIdle = true;
        }
        await sleep(pollMs);
        continue;
      }
      if (announcedIdle) console.error('[os] user idle again; resuming.');
      announcedIdle = false;
    }

    // Both gates clear — safe to send input. Foregrounding the followed tab's
    // window happens in pageToScreen, where the CDP client is in scope: `client`
    // here is the browser-input helper (no CDP Page domain), so a bringToFront on
    // it would silently throw every call and never raise anything.
    return;
  }
}

// Long-lived stdin/stdout JSON-RPC client for the Swift helper.
class BrowserInputClient {
  constructor(binPath) {
    this.binPath = binPath;
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.closed = false;
  }

  async init() {
    if (this.child) return;
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(`OS executor is not supported on ${process.platform}. Use executor: cdp instead.`);
    }
    if (!fs.existsSync(this.binPath)) {
      const buildScript = process.platform === 'linux'
        ? 'native/linux/browser-input/build.sh'
        : 'native/macos/browser-input/build.sh';
      throw new Error(
        `browser-input binary not found at ${this.binPath}. ` +
        `Build it once with: bash ${buildScript}`
      );
    }
    this.closed = false;  // fresh spawn — clear any closed flag from a prior close()/exit
    this.child = spawn(this.binPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onData(chunk));
    this.child.stderr.on('data', (chunk) => process.stderr.write(`[browser-input] ${chunk}`));
    this.child.on('exit', (code) => {
      this.closed = true;
      const err = new Error(`browser-input exited (code=${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
    // Sanity ping — also surfaces a clear error if Accessibility perms missing.
    // On failure, tear down the child we just spawned so a failed init doesn't
    // leak a browser-input process.
    try {
      await this.send({ op: 'ping' });
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (msg.ok) p.resolve(msg.data || {});
      else        p.reject(new Error(msg.error || 'browser-input error'));
    }
  }

  // timeoutMs bounds how long we wait for a reply. Without it, a helper that
  // accepts a command but never replies (wedged CGEvent, a reply line dropped
  // by _onData's JSON guard) would leave the promise pending forever and hang
  // the whole agent loop. Generous default so legitimate long `type` ops don't
  // trip it; a truly-stuck helper still fails instead of hanging indefinitely.
  send(cmd, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('browser-input is closed'));
    if (!this.child) return Promise.reject(new Error('browser-input not initialized'));
    const id = String(++this.seq);
    const payload = JSON.stringify({ id, ...cmd }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`browser-input timed out after ${timeoutMs}ms (op=${cmd.op})`));
        }
      }, timeoutMs);
      timer.unref?.();
      // Wrap settlers so the timer is always cleared, whether the reply arrives
      // via _onData, the exit handler, or close().
      const wrap = (fn) => (val) => { clearTimeout(timer); fn(val); };
      const settle = { resolve: wrap(resolve), reject: wrap(reject) };
      this.pending.set(id, settle);
      this.child.stdin.write(payload, (err) => {
        if (err && this.pending.delete(id)) settle.reject(err);
      });
    });
  }

  async close() {
    // Mark closed and reject any in-flight sends so awaiters don't hang past
    // shutdown; the exit handler does the same, but close() may run first.
    this.closed = true;
    const err = new Error('browser-input is closed');
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
    if (this.child) {
      try { this.child.stdin.end(); } catch {}
      this.child = null;
    }
  }
}

// Translate a page-coordinate point (CSS pixels, relative to the top-left of
// the document) into a screen point CGEventPost can dispatch to.
//
// Visualization:
//
//                ┌───── window.left
//                │              ┌────── chromeOffsetX (≈ 0)
//                ▼              ▼
//     ┌──────────────────────────────────┐ ◀── window.top
//     │   ▒▒▒▒▒ title / tabs / URL ▒▒▒▒▒  │ ◀── chromeOffsetY = window.height
//     │   ▒▒▒▒▒▒▒▒▒ bookmarks ▒▒▒▒▒▒▒▒▒▒  │                    - viewport.height
//     ├──────────────────────────────────┤
//     │                                  │ ◀── viewport top, where pageY = 0
//     │     ┌──────────────┐             │      (after subtracting scrollY)
//     │     │   target     │             │
//     │     └──────────────┘             │
//     │                                  │
//     └──────────────────────────────────┘
//
// Formula:    screen = window.origin + chromeOffset + (pagePoint - scroll)
//
// All values are in CSS-pixel-equivalent points:
//   - Browser.getWindowBounds returns DIPs (device-independent points).
//   - cssVisualViewport.{client,page}* are in CSS pixels.
//   - CGEvent takes screen points.
// On macOS, all three units are 1:1 (retina scaling happens below this
// layer), so no devicePixelRatio multiplication is needed.
//
// devicePixelRatio cache — keyed by CDP client so it self-expires on reconnect.
// DPR is stable within a session; fetching it on every pageToScreen call fires a
// Runtime.evaluate (page-visible) for each click/scroll on Linux. The WeakMap
// entry is collected when the client object is GC'd after a reconnect.
const _dprCache = new WeakMap();
async function getDevicePixelRatio(client) {
  if (_dprCache.has(client)) return _dprCache.get(client);
  let dpr = 1;
  try {
    const r = await client.Runtime.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true });
    const v = r?.result?.value;
    if (typeof v === 'number' && isFinite(v) && v > 0) dpr = v;
  } catch {}
  _dprCache.set(client, dpr);
  return dpr;
}

// We recompute the chrome offset on every dispatch instead of measuring it
// once: it changes when the user toggles the bookmarks bar, enters/exits
// fullscreen, or zooms. Cost is one CDP round-trip per click — negligible
// next to the humanlike mouse-move that follows.
async function pageToScreen(session, pageX, pageY, opts = {}) {
  const client = session.client;
  // Raise the pinned target's window before converting coordinates. CGEvents
  // land on whatever Chrome window is topmost at the screen point we're about to
  // hit, so a popup/new tab we followed (see Session.followActiveTab) must be
  // foregrounded or the input strikes the window behind it. This is the CDP
  // client attached to session._target, so it has the Page domain (unlike the
  // input gate's browser-input client). Best-effort — a detached target just
  // falls through and the dispatch proceeds as before.
  try { await client.Page.bringToFront(); } catch {}
  const { targetInfos } = await client.Target.getTargets();
  const tabId = session._target?.id;
  const targetInfo = targetInfos.find(t => t.targetId === tabId) || targetInfos.find(t => t.type === 'page');

  let windowBounds;
  try {
    const { windowId } = await client.Browser.getWindowForTarget(
      targetInfo ? { targetId: targetInfo.targetId } : {}
    );
    const r = await client.Browser.getWindowBounds({ windowId });
    windowBounds = r.bounds;
  } catch (err) {
    throw new Error(`Browser.getWindowBounds failed: ${err.message}`);
  }

  const metrics = await client.Page.getLayoutMetrics();
  // Prefer the `css*` variants on modern Chrome; fall back for older builds.
  // `layout` gives us scroll position (pageX/pageY) in page coordinates;
  // `visual` gives us the rendered viewport size inside the OS window.
  const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const visual = metrics.cssVisualViewport || metrics.visualViewport || {};

  // Derive the chrome offset by subtraction. Chrome doesn't expose
  // "title bar height + tab strip height + URL bar height + bookmarks bar"
  // as a single value, but the difference between the OS window and the
  // rendered viewport must be exactly that. The `88` fallback is a sensible
  // default for a normal Chrome window with the bookmarks bar visible — it
  // only kicks in if Chrome returns no viewport metrics at all.
  const cssViewportWidth  = visual.clientWidth  ?? layout.clientWidth  ?? windowBounds.width;
  const cssViewportHeight = visual.clientHeight ?? layout.clientHeight ?? (windowBounds.height - 88);
  const chromeOffsetY = Math.max(0, windowBounds.height - cssViewportHeight);
  const chromeOffsetX = Math.max(0, windowBounds.width  - cssViewportWidth);

  const scrollX = layout.pageX ?? 0;
  const scrollY = layout.pageY ?? 0;

  // `viewportRelative` callers (clickablePoint already subtracted scroll and
  // returns layout-viewport coords) skip the scroll subtraction; document-coord
  // callers (scroll) keep it.
  const localX = opts.viewportRelative ? pageX : (pageX - scrollX);
  const localY = opts.viewportRelative ? pageY : (pageY - scrollY);

  // Linux only: XTestFakeMotionEvent takes physical pixels, so coordinates must
  // be multiplied by devicePixelRatio. Cached per CDP client (getDevicePixelRatio)
  // — DPR is stable within a session and each uncached fetch fires a Runtime.evaluate.
  const dpr = process.platform === 'linux' ? await getDevicePixelRatio(client) : 1;

  const axOrigin = await viewportOriginFromNative(opts.inputClient);
  const origin = axOrigin || {
    x: windowBounds.left + chromeOffsetX,
    y: windowBounds.top + chromeOffsetY,
    source: 'cdp-derived',
  };

  const screen = {
    x: (origin.x + localX) * dpr,
    y: (origin.y + localY) * dpr,
  };

  // Set BROWSER_AGENT_DEBUG_COORDS=1 to dump the raw numbers behind each mapping. Used
  // to diagnose cursor-offset bugs on scaled / Retina / HiDPI displays.
  if (process.env.BROWSER_AGENT_DEBUG_COORDS) {
    console.error('[coords] ' + JSON.stringify({
      page: { x: Math.round(pageX), y: Math.round(pageY) },
      windowBounds,
      cssViewport: { w: cssViewportWidth, h: cssViewportHeight },
      chromeOffset: { x: chromeOffsetX, y: chromeOffsetY },
      viewportOrigin: { x: Math.round(origin.x), y: Math.round(origin.y), source: origin.source },
      scroll: { x: scrollX, y: scrollY },
      devicePixelRatio: dpr,
      screen: { x: Math.round(screen.x), y: Math.round(screen.y) },
    }));
  }

  return screen;
}

async function viewportOriginFromNative(inputClient) {
  if (process.platform !== 'darwin' || !inputClient?.send) return null;
  try {
    const r = await inputClient.send({ op: 'webarea' }, 1000);
    const x = Number(r?.x);
    const y = Number(r?.y);
    const width = Number(r?.width);
    const height = Number(r?.height);
    if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return null;
    // The native helper returns the actual AXWebArea top-left, so no Chrome UI
    // offset needs to be inferred for OS input on macOS.
    return { x, y, source: r.source || 'native-webarea' };
  } catch {
    return null;
  }
}

function jitterPause(humanize) {
  if (!humanize.enabled) return 0;
  const lo = Math.max(0, humanize.preClickPauseMsMin);
  const hi = Math.max(lo, humanize.preClickPauseMsMax);
  return lo === hi ? lo : lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function click({ session, brief, ref, client, humanize }) {
  await ensureInputSafe(client);

  // Aim at the element's real, occlusion-checked hit-point. clickablePoint scrolls
  // the target in, probes its content-quads, and returns a point that actually
  // hit-tests to the target (throwing a non-fatal "covered" error if an overlay
  // genuinely obscures every part of it). No separate assertHittable pass is
  // needed; it falls back to the bbox center when the precise path can't run.
  const pt = await clickablePoint({ session, brief, ref });

  // With humanize on, jitter the aim by ±min(dim, 8)/2 — enough that back-to-back
  // clicks on the same element don't land on identical pixels (a strong bot
  // signal), but small enough to stay inside the hit-region. Applied to the
  // already-verified point; we deliberately do NOT re-hit-test the jittered pixel
  // (the old code did, and could reject its own jitter on a <=8px target) — a
  // sub-8px nudge stays on the chosen quad, and a stray miss is a harmless retry.
  const aimX = humanize.enabled ? pt.x + (Math.random() - 0.5) * Math.min(pt.width, 8) : pt.x;
  const aimY = humanize.enabled ? pt.y + (Math.random() - 0.5) * Math.min(pt.height, 8) : pt.y;

  const screen = await pageToScreen(session, aimX, aimY, { viewportRelative: true, inputClient: client });

  await client.send({
    op: 'move',
    x: screen.x, y: screen.y,
    speedPxPerSec: humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9,
    jitterPx: humanize.enabled ? humanize.mouseJitterPx : 0,
  });

  const pause = jitterPause(humanize);
  if (pause > 0) await new Promise(r => setTimeout(r, pause));

  // Re-check after the move: focus may have changed during cursor travel. This
  // is the last gate before the actual button press lands on the foreground.
  await ensureInputSafe(client);
  await client.send({ op: 'click', button: 'left' });
}

// Select the whole node by click-dragging from its top-left to its bottom-right
// corner. Mouse down at the start anchors the selection; the move (posted as a
// drag because the button is held — see browser-input's leftButtonDown handling)
// select_text reads back the full text of a ref with no page-visible JS.
// Fast path: nodes with an accessible name already carry their full text in
// node.name from the AX tree extract — return it directly.
// Fallback: bare containers (no AX name) are read via DOM.getOuterHTML; tag-
// stripping recovers the same plain text the old drag+getSelection path
// produced, but without any page-observable side-effect or cursor movement.
async function selectText({ session, brief, ref }) {
  const node = nodeByRef(brief, ref);
  if (!node) throw new Error(`node ${ref} not found in brief`);

  if (typeof node.name === 'string' && node.name.trim()) {
    return { selectedText: node.name };
  }

  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId === 'number') {
    try {
      const { outerHTML } = await session.client.DOM.getOuterHTML({ backendNodeId });
      const text = htmlToPlainText(outerHTML);
      if (text) return { selectedText: text };
    } catch {}
  }
  return { selectedText: '' };
}

function htmlToPlainText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function type({ session, brief, ref, text, client, humanize, clear, submit }) {
  // Most reliable path: click to focus, then type. CDP's DOM.focus is faster
  // but it bypasses focus side effects (selection clearing, value committing)
  // that real keyboard focus triggers — which defeats the point of OS-level
  // input. Clicking via the same humanized path keeps the fingerprint clean.
  await click({ session, brief, ref, client, humanize });  // checks frontmost itself
  await ensureInputSafe(client);  // re-check before keystrokes land
  // Settle after focus is a correctness concern, not humanization: Chrome needs
  // a beat to commit focus before the first keystroke, or that char is dropped.
  // Floor it even when humanize is off so disabling humanize can't reintroduce
  // the missed-first-character race.
  const postFocusMs = Math.max(humanize.enabled ? humanize.postFocusPauseMs : 0, 60);
  if (postFocusMs > 0) await sleep(postFocusMs);

  // Replace existing content by default: select-all (Cmd+A) so the typing below
  // overwrites the selection. Gated to text-input roles so a misfired clear on a
  // non-text element can't trigger a page-wide selection. Best-effort — an older
  // browser-input binary without letter keycodes rejects "a"; we swallow that and
  // fall back to appending rather than failing the whole type.
  if (clear !== false && isTextInput(nodeByRef(brief, ref))) {
    try {
      const selectAllMod = process.platform === 'linux' ? 'ctrl' : 'cmd';
      await client.send({ op: 'key', key: 'a', modifiers: [selectAllMod] });
      // The Cmd/Ctrl modifier release needs to propagate before we type, or the
      // first character is read as a chord (Cmd+letter) and lost. Floor this even
      // when humanize is off — it's the dominant cause of the dropped first char.
      const postClearMs = Math.max(humanize.enabled ? humanize.postClearPauseMs : 0, 60);
      if (postClearMs > 0) await sleep(postClearMs);
    } catch (err) {
      console.error(`[os] clear-before-type skipped: ${err.message}`);
    }
  }

  await client.send({
    op: 'type',
    text,
    delayMsMin: humanize.enabled ? humanize.keystrokeDelayMsMin : 0,
    delayMsMax: humanize.enabled ? humanize.keystrokeDelayMsMax : 0,
  });
  // submit:true presses Enter to run the field's default action (search,
  // single-field form) — see the cdp backend for why this is its own option.
  if (submit) await press({ key: 'Enter', client });
}

// Map direction+amount → CGEvent scroll-wheel deltas. NOTE: CGEvent wheel sign
// is the OS gesture direction, the opposite of the DOM wheel convention the cdp
// backend uses — a negative wheel1 scrolls the page content down. This assumes
// the default (non-"natural") scroll setting and should be verified on real
// macOS; flip the signs if it scrolls the wrong way.
function osScrollDeltas(direction, amount, viewport) {
  const vw = viewport?.width ?? 1280;
  const vh = viewport?.height ?? 800;
  const step = (dim) => (amount != null ? amount : Math.round(dim * 0.85));
  const dir = String(direction || '').toLowerCase();
  switch (dir) {
    case 'up':    return { dx: 0, dy: step(vh) };
    case 'left':  return { dx: step(vw), dy: 0 };
    case 'right': return { dx: -step(vw), dy: 0 };
    case 'down':  return { dx: 0, dy: -step(vh) };
    default:      throw new Error(`unknown scroll direction "${direction}" (expected: up, down, left, right)`);
  }
}

async function scroll({ session, brief, direction, amount, client, humanize }) {
  await ensureInputSafe(client);
  const vp = brief.viewport || {};
  // Park the cursor over the page center first so the wheel lands on content,
  // not the browser chrome (scroll posts at the current cursor position).
  const pageCenterX = (vp.scrollX ?? 0) + (vp.width ?? 0) / 2;
  const pageCenterY = (vp.scrollY ?? 0) + (vp.height ?? 0) / 2;
  const screen = await pageToScreen(session, pageCenterX, pageCenterY, { inputClient: client });
  await client.send({
    op: 'move',
    x: screen.x, y: screen.y,
    speedPxPerSec: humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9,
    jitterPx: humanize.enabled ? humanize.mouseJitterPx : 0,
  });
  const { dx, dy } = osScrollDeltas(direction, amount, vp);
  await ensureInputSafe(client);  // last gate before the wheel event lands
  if (humanize.enabled) {
    await client.send({
      op: 'scrollGesture',
      dx, dy,
      durationMs: humanize.scrollDurationMs ?? 400,
      jitterPx: humanize.scrollJitterPx ?? 3,
    });
  } else {
    await client.send({ op: 'scroll', dx, dy });
  }
}

async function press({ key, client }) {
  await ensureInputSafe(client);
  await client.send({ op: 'key', key: String(key) });
}

// ─── Omnibox-typing navigate (visible) ────────────────────────────────────────
//
// A prior attempt at visible omnibox typing was removed because of three failure
// modes: Cmd+L modifier-release racing the first keystroke (dropped chars +
// stray Cmd+T new tabs), and a "killed CDP target" mode that followed from a
// stray tab opening. This version brings the visible typing back by fixing each
// mode at the source:
//
//   1. Modifier-release race
//      • POST_CMDL_PAUSE_MS = 200ms gap between Cmd+L and the first typed char.
//      • type() runs at humanize.keystrokeDelayMsMin/Max (25–85ms), so even with
//        an unlucky scheduler the Cmd flag has fully cleared the input queue
//        before "h" lands.
//      • The native helper zeroes modifier flags on each key-up (main.swift),
//        so a chord can't persist *across* ops; only the in-op tail mattered.
//
//   2. Stray Cmd+T new tabs (consequence of #1)
//      • Same fix. With the modifier guaranteed released before typing, the
//        first character cannot be re-interpreted as a chord.
//
//   3. Killed CDP target
//      • Was a downstream consequence of #2: a stray tab opens, followActiveTab
//        repins the session, the old client closes. No stray tab → no repin.
//      • We additionally use CDP Page.navigate for the *actual* navigation, not
//        Enter, so omnibox autocomplete can't redirect us to a different URL
//        and there is no "Enter races load listener" timing concern. The typing
//        is purely visual; the load is the same rock-solid CDP path navigate()
//        already takes on both backends.
//
// Net visual: cursor glides to the address bar, Cmd+L highlights it, URL types
// in character-by-character, page loads. Net cost: the type animation runs in
// parallel with the navigation's existing load+idle wait, so wall-clock is
// dominated by the longer of (URL length × per-char delay) and the page load —
// often free against a real load.

async function typeUrlInOmnibox({ session, client, humanize, url }) {
  // 1. Glide the real cursor up to the omnibox. Cosmetic; we never click there.
  await ensureInputSafe(client);
  const m = await session.client.Page.getLayoutMetrics();
  const v = m.cssVisualViewport || m.visualViewport || m.cssLayoutViewport || m.layoutViewport || {};
  const vw = v.clientWidth || 1280;
  const top = await pageToScreen(session, vw / 2, 0, { viewportRelative: true, inputClient: client });
  await client.send({
    op: 'move',
    x: top.x,
    y: top.y - OMNIBOX_INSET_PX,
    speedPxPerSec: humanize.enabled ? humanize.mouseSpeedPxPerSec : 1e9,
    jitterPx: humanize.enabled ? humanize.mouseJitterPx : 0,
  });

  // 2. Cmd+L → focus the omnibox and select its current contents (Ctrl+L on
  //    Linux). The native helper presses+releases the modifier atomically; the
  //    sleep below covers the input-queue tail race against the next op.
  await ensureInputSafe(client);
  const omniboxMod = process.platform === 'linux' ? 'ctrl' : 'cmd';
  await client.send({ op: 'key', key: 'l', modifiers: [omniboxMod] });
  await sleep(POST_CMDL_PAUSE_MS);

  // 3. Type the URL. Uses the same humanized per-key delays as type() so the
  //    first character lands well after the Cmd release has propagated, and the
  //    rest cadence-matches the rest of the agent for a clean visual feel.
  await ensureInputSafe(client);
  await client.send({
    op: 'type',
    text: url,
    delayMsMin: humanize.enabled ? humanize.keystrokeDelayMsMin : 0,
    delayMsMax: humanize.enabled ? humanize.keystrokeDelayMsMax : 0,
  });
}

// OS-backend navigate: when humanize.typeOmnibox is on, run the visible typing
// flow ALONGSIDE the real CDP navigation. The flow:
//   • Arm the load listener (must be done before the navigation fires, per the
//     comment in page.js:waitForLoad — arming after a fast load races out).
//   • Kick off the visible typing as a background promise.
//   • Fire Page.navigate immediately — the load wait inside navigate() runs
//     concurrently with the typing animation, so total wall-clock = max(load,
//     typing) rather than load + typing.
//   • Await both. The typing is wrapped in a soft-fail: a keystroke error must
//     never break a real navigation, so we log and continue.
async function osNavigate({ session, url, client, humanize }) {
  const visible = humanize.enabled && humanize.typeOmnibox !== false;

  if (!visible) return navigate({ session, url });

  // Validate the URL the same way the CDP path does, so a bad URL fails BEFORE
  // we type anything visible. Returns the normalized form we'll type.
  let normalized;
  try { normalized = normalizeUrl(url); }
  catch (err) { throw err; }   // surface the validation error as-is

  // Run the visible animation in parallel with the real navigation. If the
  // animation throws (driver gone, modifier race, etc.) we swallow it — the
  // navigation still happens via Page.navigate below.
  const animation = typeUrlInOmnibox({ session, client, humanize, url: normalized })
    .catch(err => {
      if (process.env.BROWSER_AGENT_DEBUG_NAV) console.error(`[nav] omnibox typing skipped: ${err?.message || err}`);
    });

  // navigate() arms its own load listener before calling Page.navigate, so we
  // get the same load+idle wait the cdp backend gets — no listener race.
  const nav = navigate({ session, url: normalized });

  // Wait for BOTH so the action doesn't return mid-animation (which would let
  // the next loop iteration's extract fire while the cursor is still parked at
  // the omnibox — fine functionally, but ugly visually for a demo).
  await Promise.all([nav, animation]);
}

function create(opts = {}) {
  const binPath = opts.binPath || DEFAULT_BIN;
  const humanize = mergeHumanize(opts.humanize);
  const client = new BrowserInputClient(binPath);
  // When the human is using the same machine, pause input while they're active
  // and resume once they've been idle for thresholdMs (see ensureInputSafe).
  client.idleGuard = {
    enabled: opts.pauseOnUserInput !== false,
    thresholdMs: Number.isFinite(opts.userIdleMs) ? opts.userIdleMs : 600,
  };
  // End the run if Chrome stays out of the foreground this long — it quit or
  // crashed — instead of pausing forever (see ensureInputSafe's frontmost gate).
  // Default 5 min; set executor.frontmostTimeoutMs: 0 to pause indefinitely.
  client.frontmostTimeoutMs = Number.isFinite(opts.frontmostTimeoutMs) ? opts.frontmostTimeoutMs : 300000;

  return {
    name: 'os',
    async init() { await client.init(); },
    async close() { await client.close(); },
    async waitUntilReady() { await ensureInputSafe(client); },
    click:  (args) => click({ ...args, client, humanize }),
    select_text: (args) => selectText(args),
    type:   (args) => type({ ...args, client, humanize }),
    scroll: (args) => scroll({ ...args, client, humanize }),
    press:  (args) => press({ ...args, client }),
    navigate: (args) => osNavigate({ ...args, client, humanize }),   // visible omnibox-typing + CDP Page.navigate
    back:   (args) => back(args),         // CDP history back (args carries session)
    // Backend-agnostic — read/capture via session.client (CDP), not browser-input.
    take_screenshot: (args) => captureScreenshot(args),
    save_file: (args) => saveFile(args),
    get_files: (args) => getFiles(args),
  };
}

module.exports = { create, DEFAULT_HUMANIZE, ensureInputSafe, pageToScreen };
