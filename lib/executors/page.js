'use strict';

// CDP-only page commands.

// Bounded wait for the page's load event after a full navigation. A navigate
// (address-bar) always triggers a real document load, so Page.loadEventFired is
// the browser-authoritative signal that the next snapshot won't catch a blank /
// still-parsing page. Bounded by a timeout because some pages never fully
// quiesce (long-polling, websockets, beacons) or never fire load — a slow load
// must not stall the agent. Default 5s; override with BROWSER_AGENT_NAV_TIMEOUT_MS.
const NAV_LOAD_TIMEOUT_MS = Number(process.env.BROWSER_AGENT_NAV_TIMEOUT_MS) || 5000;

// After the load event, SPA and AJAX-heavy pages may still be fetching dynamic
// content. NAV_IDLE_MS is the quiet period (no new requests) that signals the
// page has settled; NAV_IDLE_TIMEOUT_MS caps the total wait so persistent
// background activity (long-poll, SSE, WebSocket) never stalls the agent.
const NAV_IDLE_MS         = Number(process.env.BROWSER_AGENT_IDLE_MS)         || 120;
const NAV_IDLE_TIMEOUT_MS = Number(process.env.BROWSER_AGENT_IDLE_TIMEOUT_MS) || 2000;

// Resolve on the next Page.loadEventFired, or after `timeoutMs` — whichever is
// first. Never rejects: this only bounds how long we block, it must not turn a
// slow load into a failed navigate. The caller MUST construct this (which arms
// the listener) BEFORE triggering the navigation; arming after the trigger races
// a fast load and would wait out the whole timeout for nothing.
function waitForLoad(client, timeoutMs = NAV_LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.removeListener('Page.loadEventFired', onLoad); } catch {}
      resolve(reason);
    };
    const onLoad = () => finish('load');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    timer.unref?.();
    client.on('Page.loadEventFired', onLoad);
  });
}

// Wait until no Network request has been in-flight for `idleMs` consecutive
// milliseconds, bounded by `timeoutMs`. Resolves with a reason string and never
// rejects. Falls back immediately ('unsupported') when the client has no Network
// domain (test doubles, OS backend). Requires Network.enable() to have been
// called by the caller before the navigation fires so early requests are counted.
function waitForNetworkIdle(client, idleMs = NAV_IDLE_MS, timeoutMs = NAV_IDLE_TIMEOUT_MS) {
  if (typeof client?.Network?.enable !== 'function') return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    let inFlight = 0;
    let idleTimer = null;
    let settled = false;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      try { client.removeListener('Network.requestWillBeSent', onRequest); } catch {}
      try { client.removeListener('Network.loadingFinished', onDone); } catch {}
      try { client.removeListener('Network.loadingFailed', onDone); } catch {}
      resolve(reason);
    };

    const scheduleIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), idleMs);
      idleTimer.unref?.();
    };

    const onRequest = () => {
      inFlight++;
      clearTimeout(idleTimer);
    };

    const onDone = () => {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0) scheduleIdle();
    };

    const totalTimer = setTimeout(() => finish('timeout'), timeoutMs);
    totalTimer.unref?.();

    client.on('Network.requestWillBeSent', onRequest);
    client.on('Network.loadingFinished', onDone);
    client.on('Network.loadingFailed', onDone);

    // Begin idle countdown immediately; it resets whenever a request starts.
    scheduleIdle();
  });
}

// One-shot readiness wait for the page the agent connects to on turn 1. There's
// no navigation to arm a listener ahead of — the page may already be loaded, in
// which case loadEventFired will never fire again — so we check readyState first
// and only fall back to the (bounded) load-event wait when it's still loading.
// Network.enable() is called here so the subsequent waitForNetworkIdle call can
// observe any in-flight requests from this point forward.
// Best-effort: a client without the Page/Runtime domains (e.g. a test double)
// returns 'unsupported' rather than throwing. Returns the reason for logging.
async function waitUntilLoaded(client, timeoutMs = NAV_LOAD_TIMEOUT_MS) {
  if (typeof client?.Page?.enable !== 'function') return 'unsupported';
  await client.Page.enable();
  try { await client.Network?.enable?.(); } catch {}
  let state = null;
  try {
    const r = await client.Runtime.evaluate({ expression: 'document.readyState', returnByValue: true });
    state = r?.result?.value ?? null;
  } catch { /* readyState unreadable — fall through to the load-event wait */ }
  const loadReason = state === 'complete' ? 'already-complete' : await waitForLoad(client, timeoutMs);
  const idleReason = await waitForNetworkIdle(client);
  return `${loadReason}+idle:${idleReason}`;
}

// Navigate the current tab to a URL via CDP. A bare host like "example.com" gets
// an https:// scheme prepended so the model doesn't have to remember it.
//
// Only http/https are allowed. The navigate target can originate from page text
// the model just read (prompt injection: a hostile page says "go to ..."), so we
// must not let it steer the browser into local files or privileged pages —
// file:// (read the user's disk), chrome://, about:, view-source:, data:, etc.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('navigate requires a url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`invalid url: ${url}`); }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`refusing to navigate to "${parsed.protocol}" — only http/https are allowed`);
  }
  return parsed.href;
}

// Page.navigate resolves on *commit* (first bytes), not load. Arm the load wait
// first, trigger the navigation, then block on the load event (bounded) so the
// next snapshot sees a loaded document instead of a blank / parsing one.
// Network.enable() is called before arming the load listener so every request
// the new document fires is observable by the subsequent waitForNetworkIdle call.
async function navigate({ session, url }) {
  const u = normalizeUrl(url);
  const client = session.client;
  await client.Page.enable();
  try { await client.Network?.enable?.(); } catch {}
  const loaded = waitForLoad(client);
  await client.Page.navigate({ url: u });
  const loadReason = await loaded;
  const idleReason = await waitForNetworkIdle(client);
  if (process.env.BROWSER_AGENT_DEBUG_NAV) console.error(`[nav] ${u} → ${loadReason}+idle:${idleReason}`);
}

// Go back one entry in the tab's session history (the browser Back button). Used
// to return to a previous page. We wait with waitUntilLoaded, NOT waitForLoad:
// a back-nav often restores from the bfcache, which is already 'complete' and
// never fires a fresh load event — waitForLoad would wait out the full timeout
// for nothing.
//
// When there's no history in this tab but other page tabs are open, we close
// the tab instead of throwing. followActiveTab then re-pins the session to the
// opener (or the newest remaining tab) on the next extract — this is the natural
// recovery when a new tab was opened for a detail page and the model wants to
// go back to the listing.
//
// Throws (non-fatal) only when there's nowhere to go: no history and no other
// tabs, so the loop surfaces it and the model picks something else.
async function back({ session }) {
  const client = session.client;
  await client.Page.enable();
  const { currentIndex, entries } = await client.Page.getNavigationHistory();
  if (!Array.isArray(entries) || currentIndex <= 0) {
    const targetId = session._target?.id;
    if (targetId) {
      try {
        const { targetInfos } = await client.Target.getTargets();
        const others = (targetInfos || []).filter(t => t.type === 'page' && t.targetId !== targetId);
        if (others.length > 0) {
          await client.Target.closeTarget({ targetId });
          if (typeof session.followActiveTab === 'function') await session.followActiveTab(false);
          return;
        }
      } catch {}
    }
    throw new Error("cannot go back — no previous page in this tab's history");
  }
  await client.Page.navigateToHistoryEntry({ entryId: entries[currentIndex - 1].id });
  const reason = await waitUntilLoaded(client);
  if (process.env.BROWSER_AGENT_DEBUG_NAV) console.error(`[nav] back → ${reason}`);
}

function bbox(node) {
  const b = node?.bbox;
  if (!b) return null;
  return Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : b;
}

// click/select_text target text (@t) or element (@e) refs, so look in both.
function nodeByRef(brief, ref) {
  return (brief.elements || []).find(n => n.ref === ref)
    ?? (brief.text || []).find(n => n.ref === ref)
    ?? null;
}

// Roles whose value is free-text the user edits — the only nodes where a
// "clear before type" (select-all) is meaningful and safe. Gating clear on
// these prevents a stray clear:true on a button from issuing a page-wide
// Cmd/Ctrl+A. `combobox` is included: an editable combobox (autocomplete) holds
// a text value; a non-editable one ignores select-all harmlessly.
const TEXT_INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
function isTextInput(node) {
  if (!node) return false;
  if (TEXT_INPUT_ROLES.has(node.role)) return true;
  // A node carrying a string `value` is a filled field even if its role is a
  // custom/non-semantic one (some sites label inputs only via aria).
  return typeof node.value === 'string';
}

// ─── Click targeting ──────────────────────────────────────────────────────────

// A bbox center is the wrong aim point for two real shapes: a large container
// whose center sits over a non-interactive child, and a multi-line inline link
// whose center falls in the gap between its line boxes. DOM.getContentQuads
// returns the element's actual hit polygon(s) — one rect per line box — so we
// can aim inside the real, visible geometry. Coordinates come back relative to
// the layout VIEWPORT (scroll already applied), matching what
// Input.dispatchMouseEvent and DOM.getNodeForLocation expect.
function quadToRect(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function intersectRect(r, vw, vh) {
  const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y);
  const x2 = Math.min(r.x + r.width, vw), y2 = Math.min(r.y + r.height, vh);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

// All content quads clamped to the viewport, largest visible area first (zero-area
// rects dropped) — one rect per line box. We keep the whole list, not just the
// best one, so the occlusion probe below can spread candidate aim points across
// every line box. Falls back to the single largest RAW quad when nothing
// intersects the viewport (e.g. the element couldn't be fully scrolled in) so we
// still aim at real geometry rather than give up.
function visibleQuadRects(quads, vw, vh) {
  if (!Array.isArray(quads)) return [];
  const clampable = Number.isFinite(vw) && Number.isFinite(vh);
  const rects = [];
  let bestRaw = null, bestRawArea = -1;
  for (const q of quads) {
    if (!Array.isArray(q) || q.length < 8) continue;
    const raw = quadToRect(q);
    const rawArea = raw.width * raw.height;
    if (rawArea > bestRawArea) { bestRawArea = rawArea; bestRaw = raw; }
    const rect = clampable ? intersectRect(raw, vw, vh) : raw;
    if (rect.width * rect.height > 0) rects.push(rect);
  }
  if (rects.length) {
    rects.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return rects;
  }
  return bestRaw ? [bestRaw] : [];
}

// The single largest visible quad-rect: the geometry we report (for jitter
// bounds) and a back-compat helper. Aim-point selection now lives in
// candidatePoints + the occlusion probe, not here.
function bestQuadRect(quads, vw, vh) {
  return visibleQuadRects(quads, vw, vh)[0] || null;
}

// Candidate aim points for the visible quad-rects, best (largest) first:
//   - the center of each rect — handles a multi-line link by aiming at a real
//     line box instead of the empty gap between its lines;
//   - plus a quincunx (4 inset corners) of the LARGEST rect — so a target whose
//     center is painted over by an overlapping sibling (a "stretched-link" card,
//     a heading drawn across a full-card link) is still reachable at a corner the
//     sibling doesn't cover.
// Corners are inset 25% so a point never lands on a 1px border shared with a
// neighbor. Capped so a pathological element can't blow the hit-test budget.
const MAX_CLICK_CANDIDATES = 8;
function candidatePoints(rects) {
  const pts = [];
  const push = (x, y) => { if (pts.length < MAX_CLICK_CANDIDATES) pts.push({ x, y }); };
  if (!rects.length) return pts;
  const big = rects[0];
  push(big.x + big.width / 2, big.y + big.height / 2);          // best-quad center
  const ix = big.width * 0.25, iy = big.height * 0.25;
  push(big.x + ix, big.y + iy);                                  // quincunx corners
  push(big.x + big.width - ix, big.y + iy);
  push(big.x + ix, big.y + big.height - iy);
  push(big.x + big.width - ix, big.y + big.height - iy);
  for (let i = 1; i < rects.length; i++) {                       // remaining line boxes
    push(rects[i].x + rects[i].width / 2, rects[i].y + rects[i].height / 2);
  }
  return pts;
}

// Resolve a ref to a viewport-relative aim point that is BOTH inside the element's
// real geometry AND actually clickable (top-most) there. Returns
// { x, y, width, height, scrollX, scrollY, backendNodeId, source }, all in CSS
// pixels relative to the layout viewport.
//
// The precise path uses DOM.getContentQuads for geometry and probes several
// candidate points (see candidatePoints) with DOM.getNodeForLocation, returning
// the first that resolves to the target. This folds in the old separate
// "assertHittable" pass: a target whose CENTER is occluded by an overlapping
// sibling is no longer falsely reported "covered" when its other points are
// clickable. Only when EVERY candidate is genuinely covered do we throw a
// non-fatal "covered" error (→ error Observation; the loop dismisses the overlay
// and retries).
//
// Fail-open throughout: an unsupported CDP call (e.g. the test double) or a node
// with no layout falls back to the brief's bbox center; an unavailable hit-test
// falls back to the best-quad center — so this never invents a failure mode the
// plain bbox-center behavior didn't already have.
async function clickablePoint({ session, brief, ref }) {
  const client = session.client;
  const backendNodeId = brief.lookup?.[ref];
  const node = nodeByRef(brief, ref);
  const fallback = bbox(node);

  const vp = brief.viewport || {};
  let scrollX = vp.scrollX ?? 0, scrollY = vp.scrollY ?? 0;
  let vw = vp.width ?? Infinity, vh = vp.height ?? Infinity;

  if (typeof backendNodeId === 'number' && client.DOM && client.Page) {
    let rects = null;
    try {
      await client.DOM.enable();
      await client.DOM.getDocument();
      try { await client.DOM.scrollIntoViewIfNeeded({ backendNodeId }); } catch {}
      // Re-read scroll/viewport AFTER any scroll so the quad coords (which are
      // post-scroll viewport coords) line up with the offsets we report.
      const m = await client.Page.getLayoutMetrics();
      const lv = m.cssLayoutViewport || m.layoutViewport || {};
      scrollX = lv.pageX ?? scrollX;
      scrollY = lv.pageY ?? scrollY;
      vw = lv.clientWidth ?? vw;
      vh = lv.clientHeight ?? vh;
      const { quads } = await client.DOM.getContentQuads({ backendNodeId });
      rects = visibleQuadRects(quads, vw, vh);
    } catch { rects = null; }   // CDP geometry unavailable → bbox-center fallback below

    if (rects && rects.length) {
      const aim = await pickHittablePoint({ client, backendNodeId, ref, rects });
      return {
        x: aim.x, y: aim.y,
        width: rects[0].width, height: rects[0].height,
        scrollX, scrollY, backendNodeId, source: 'quad',
      };
    }
  }

  if (!node) throw new Error(`element ${ref} not found in brief`);
  if (!fallback) throw new Error(`element ${ref} has no bbox`);
  return {
    x: fallback.x + fallback.width / 2 - scrollX,
    y: fallback.y + fallback.height / 2 - scrollY,
    width: fallback.width,
    height: fallback.height,
    scrollX, scrollY, backendNodeId, source: 'bbox',
  };
}

// Probe one point: is the node painted at (x,y) the target, inside its subtree, or
// an ancestor of it (the target is a styled child of the painted node)? Returns
// { verdict, hitId } where verdict is true (clickable here), false (covered here),
// or null (the hit-test couldn't decide — off-surface, OOPIF, describeNode threw).
async function probePoint(client, targetId, x, y) {
  let hit;
  try {
    hit = await client.DOM.getNodeForLocation({ x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
  } catch { return { verdict: null, hitId: null }; }
  const hitId = hit?.backendNodeId;
  if (typeof hitId !== 'number') return { verdict: null, hitId: null };
  if (hitId === targetId) return { verdict: true, hitId };
  try {
    if (await subtreeContains(client, targetId, hitId)) return { verdict: true, hitId };  // hit is inside target
    if (await subtreeContains(client, hitId, targetId)) return { verdict: true, hitId };  // target is inside hit
  } catch { return { verdict: null, hitId }; }
  return { verdict: false, hitId };
}

// Pick the first candidate point that actually hit-tests to the target. Fails
// OPEN — returns the best-quad center unverified — when the hit-test machinery is
// absent (test double) or never returns a verdict (every probe off-surface).
// Throws a non-fatal "covered" error only when the machinery works yet NO point
// resolves to the target: a genuine overlay the loop should dismiss. The common
// case (center is clickable) costs a single getNodeForLocation round-trip.
async function pickHittablePoint({ client, backendNodeId, ref, rects }) {
  const points = candidatePoints(rects);
  const center = points[0];
  const d = await diagnoseClickTarget({ client, backendNodeId, rects });
  if (d.status === 'clear' || d.status === 'partial') return d.point;
  if (d.status !== 'covered') return center;   // machinery never decided → fail open

  throw new Error(
    `click target ${ref} is covered at (${Math.round(center.x)},${Math.round(center.y)}) by ${d.coveredBy || 'another element'} — ` +
    `dismiss or scroll past the overlay, then retry`
  );
}

// Non-throwing variant used by the debug overlay. Same candidate order and
// hit-test semantics as pickHittablePoint, but returns the diagnosis instead of
// choosing/failing the action.
async function diagnoseClickTarget({ client, backendNodeId, rects }) {
  const points = candidatePoints(rects);
  const center = points[0] || null;
  if (!center) return { status: 'unknown', detail: 'no visible click candidates', point: null };
  if (typeof client.DOM?.getNodeForLocation !== 'function') {
    return { status: 'unknown', detail: 'hit-test unavailable', point: center };
  }

  let sawVerdict = false, coveredById = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const { verdict, hitId } = await probePoint(client, backendNodeId, p.x, p.y);
    if (verdict === true) {
      return {
        status: i === 0 ? 'clear' : 'partial',
        detail: i === 0 ? 'center hits target' : 'center covered; alternate point hits target',
        point: p,
      };
    }
    if (verdict === false) {
      sawVerdict = true;
      if (coveredById == null) coveredById = hitId;
    }
  }

  if (!sawVerdict) {
    return { status: 'unknown', detail: 'hit-test returned no usable verdict', point: center };
  }

  const coveredBy = coveredById != null ? await describeNodeForError(client, coveredById) : 'another element';
  return { status: 'covered', detail: `covered by ${coveredBy}`, point: center, coveredBy };
}

// ─── Hit-test verification ──────────────────────────────────────────────────────

// Walk the (pierced) subtree of `rootBackendId` looking for `needleBackendId`.
// Pure CDP — no page JS — so it preserves the no-footprint perception contract.
//
// `pseudoElements` MUST be traversed: getNodeForLocation can paint a node's own
// ::before/::after over its click point (some sites draw a decorative ::after
// across the whole control). Without this branch that pseudo
// reads as a foreign occluder and clickablePoint throws a bogus "covered" — even
// though a real click sails through to the element. Rooting the walk at the
// target keeps this tight: only the target's OWN decoration is absolved; a
// genuine overlay's pseudo lives outside this subtree and still reports covered.
async function subtreeContains(client, rootBackendId, needleBackendId) {
  const { node } = await client.DOM.describeNode({ backendNodeId: rootBackendId, depth: -1, pierce: true });
  let found = false;
  (function walk(n) {
    if (!n || found) return;
    if (n.backendNodeId === needleBackendId) { found = true; return; }
    for (const k of n.children || []) walk(k);
    if (n.contentDocument) walk(n.contentDocument);
    for (const sr of n.shadowRoots || []) walk(sr);
    for (const pe of n.pseudoElements || []) walk(pe);
  })(node);
  return found;
}

// Build a short, human-readable label for the node intercepting a click, for
// the error the agent sees ("...covered by <div id=cookie-wall>").
async function describeNodeForError(client, backendNodeId) {
  try {
    const { node } = await client.DOM.describeNode({ backendNodeId });
    const tag = String(node.localName || node.nodeName || 'element').toLowerCase();
    const attrs = node.attributes || [];
    const get = (name) => {
      for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1];
      return null;
    };
    const id = get('id'), aria = get('aria-label'), cls = get('class');
    let s = `<${tag}`;
    if (id) s += ` id="${id}"`;
    else if (aria) s += ` aria-label="${aria}"`;
    else if (cls) s += ` class="${String(cls).split(/\s+/).slice(0, 2).join(' ')}"`;
    return s + '>';
  } catch {
    return 'another element';
  }
}

// Ensure the ref's element is within the viewport, scrolling it in if its center
// has fallen outside (inViewportOnly only requires *intersection*, so a node can
// be in the brief with its clickable center below the fold — which is how we got
// a cursor driven off the page). Returns the LIVE scroll offset after any scroll,
// so callers using page-coordinate bboxes compute correct positions. The os
// backend reads live scroll in pageToScreen and can ignore the return; the cdp
// backend needs it because it subtracts scroll from page coords itself.
//
// Fast path: when the center is already in view, no DOM work — just hand back the
// brief's own scroll offset, so the common case stays a no-op.
async function ensureInView({ session, brief, ref }) {
  const node = (brief.elements || []).find(n => n.ref === ref)
    || (brief.text || []).find(n => n.ref === ref);
  const b = bbox(node);
  const vp = brief.viewport || {};
  const sx = vp.scrollX ?? 0, sy = vp.scrollY ?? 0;

  if (b) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const inX = cx >= sx && cx <= sx + (vp.width ?? Infinity);
    const inY = cy >= sy && cy <= sy + (vp.height ?? Infinity);
    if (inX && inY) return { scrollX: sx, scrollY: sy, scrolled: false };
  }

  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId !== 'number') return { scrollX: sx, scrollY: sy, scrolled: false };

  const client = session.client;
  await client.DOM.enable();
  await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) return { scrollX: sx, scrollY: sy, scrolled: false };

  try { await client.DOM.scrollIntoViewIfNeeded({ nodeId }); } catch {}
  const m = await client.Page.getLayoutMetrics();
  const lv = m.cssLayoutViewport || m.layoutViewport || {};
  return { scrollX: lv.pageX ?? sx, scrollY: lv.pageY ?? sy, scrolled: true };
}

module.exports = {
  navigate, back, ensureInView, normalizeUrl,
  waitForLoad, waitUntilLoaded, waitForNetworkIdle,
  NAV_LOAD_TIMEOUT_MS, NAV_IDLE_MS, NAV_IDLE_TIMEOUT_MS,
  clickablePoint, diagnoseClickTarget, isTextInput,
  // exported for testing
  bestQuadRect, visibleQuadRects, candidatePoints, quadToRect, intersectRect,
};
