'use strict';

// CDP executor — dispatches actions via Chrome DevTools Protocol input events.
//
// This path produces JS MouseEvents with `isTrusted: true` (per CDP spec) but
// still leaves a CDP-shaped fingerprint: synthesized events don't traverse the
// HID layer, motion is teleported (no curve), and timing is uniformly tight.
// Use the `os` executor for production / stealth runs. This executor exists
// for CI, headless tests, and quick iteration where Accessibility permission
// isn't available.

const { navigate, back, ensureInView, clickablePoint, isTextInput } = require('./page');
const { screenshot } = require('../screenshot');
const { saveFile } = require('../savefile');
const { getFiles } = require('../media');

function bboxArrToObj(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox)) return { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] };
  return bbox;
}

function elementByRef(brief, ref) {
  return brief.elements?.find(e => e.ref === ref) ?? null;
}

// click and select_text target text (@t) or element (@e) refs, so look in both.
function nodeByRef(brief, ref) {
  return brief.elements?.find(n => n.ref === ref)
    ?? brief.text?.find(n => n.ref === ref)
    ?? null;
}

async function click({ session, brief, ref }) {
  // Aim at the element's real, occlusion-checked hit-point. clickablePoint scrolls
  // the target in, probes its content-quads with DOM.getNodeForLocation, and
  // returns a point that actually hit-tests to the target — throwing a non-fatal
  // "covered" error (→ error Observation, loop re-plans) only when an overlay
  // genuinely obscures every part of it. Falls back to the bbox center otherwise.
  const { x, y } = await clickablePoint({ session, brief, ref });
  const client = session.client;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

// Select the whole node by click-dragging from its top-left to its bottom-right
// corner. The browser anchors the selection at the press point and extends it to
// the last move point, so a top-left → bottom-right drag covers every line in
// between. `buttons: 1` marks the left button held during the move so it's a
// drag, not a hover. Coords are viewport-relative (subtract scroll), like click.
async function selectText({ session, brief, ref }) {
  const node = nodeByRef(brief, ref);
  if (!node) throw new Error(`node ${ref} not found in brief`);
  if (typeof node.name === 'string' && node.name.trim()) {
    return { selectedText: node.name };
  }
  const bbox = bboxArrToObj(node.bbox);
  if (!bbox) throw new Error(`node ${ref} has no bbox`);
  const { scrollX, scrollY } = await ensureInView({ session, brief, ref });
  const x1 = bbox.x + 1 - scrollX;
  const y1 = bbox.y + 1 - scrollY;
  const x2 = bbox.x + bbox.width - 1 - scrollX;
  const y2 = bbox.y + bbox.height - 1 - scrollY;
  const client = session.client;
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: x1, y: y1 });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: x2, y: y2, button: 'left', buttons: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 1, clickCount: 1 });
  return { selectedText: await readSelection(client) };
}

// Read the current selection so the action can report what it highlighted. This
// is the one place we evaluate JS in the page — an action-time confirmation
// read, not part of perception, so the no-footprint extraction path is unaffected.
async function readSelection(client) {
  try {
    const { result } = await client.Runtime.evaluate({
      expression: 'window.getSelection().toString()',
      returnByValue: true,
    });
    return result?.value || '';
  } catch {
    return '';
  }
}

// Select-all in the focused field via the platform accelerator (Meta+A on
// macOS, Ctrl+A elsewhere) so the subsequent insertText replaces the selection
// rather than appending. CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
async function selectAll(client) {
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  const a = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers };
  await client.Input.dispatchKeyEvent({ type: 'keyDown', ...a });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...a });
}

async function type({ session, brief, ref, text, clear, submit }) {
  const el = elementByRef(brief, ref);
  if (!el) throw new Error(`element ${ref} not found in brief`);
  const backendNodeId = brief.lookup?.[ref];
  if (typeof backendNodeId !== 'number') throw new Error(`no backendNodeId for ${ref}`);
  const client = session.client;
  // The extractor uses `backendNodeId` (stable across snapshots) but DOM.focus
  // wants `nodeId` (a renderer-local handle that may not yet exist on the
  // frontend side). The two-step dance below registers the node with the
  // frontend and gets us a usable `nodeId`. `DOM.getDocument()` is the
  // documented prerequisite — without it, push returns nothing.
  await client.DOM.enable();
  await client.DOM.getDocument();
  const { nodeIds } = await client.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  const nodeId = nodeIds?.[0];
  if (!nodeId) throw new Error(`could not resolve nodeId for ${ref}`);
  await client.DOM.focus({ nodeId });
  // Replace existing content by default (clear:false to append). Gated to
  // text-input roles so a misfired clear can't select-all the page.
  if (clear !== false && isTextInput(el)) await selectAll(client);
  // insertText is the IME-style path: bypasses per-key keymapping, works for
  // any Unicode. Replaces the current selection (so a preceding select-all
  // overwrites the field). Per-character timing is uniform (no humanize) —
  // that's the tradeoff for using the CDP backend.
  await client.Input.insertText({ text });
  // submit:true runs the field's default action (search, single-field form) by
  // pressing Enter at the current focus — saves the model a separate press turn,
  // which smaller models routinely forget, leaving them re-typing a query that
  // never executes.
  if (submit) await press({ session, key: 'Enter' });
}

// Resolve direction+amount into wheel deltas. Positive deltaY scrolls the page
// down (standard DOM wheel convention), positive deltaX scrolls right. Default
// step is ~85% of the viewport so one scroll reveals roughly a fresh screenful
// with a little overlap.
function scrollDeltas(direction, amount, viewport) {
  const vw = viewport?.width ?? 1280;
  const vh = viewport?.height ?? 800;
  const step = (dim) => (amount != null ? amount : Math.round(dim * 0.85));
  const dir = String(direction || '').toLowerCase();
  switch (dir) {
    case 'up':    return { deltaX: 0, deltaY: -step(vh) };
    case 'left':  return { deltaX: -step(vw), deltaY: 0 };
    case 'right': return { deltaX: step(vw), deltaY: 0 };
    case 'down':  return { deltaX: 0, deltaY: step(vh) };
    default:      throw new Error(`unknown scroll direction "${direction}" (expected: up, down, left, right)`);
  }
}

async function scroll({ session, brief, direction, amount }) {
  const vp = brief.viewport || {};
  const { deltaX, deltaY } = scrollDeltas(direction, amount, vp);
  // Wheel at the viewport center so it lands on page content, not the chrome.
  const x = Math.round((vp.width ?? 0) / 2);
  const y = Math.round((vp.height ?? 0) / 2);
  await session.client.Input.dispatchMouseEvent({ type: 'mouseWheel', x, y, deltaX, deltaY });
}

// Named keys an agent realistically presses → CDP dispatchKeyEvent fields.
// Keys that produce a character carry `text` (dispatched as keyDown); the rest
// use rawKeyDown. Letters/numbers go through `type`, not here.
const CDP_KEYS = {
  enter:      { key: 'Enter',      code: 'Enter',      vk: 13, text: '\r' },
  return:     { key: 'Enter',      code: 'Enter',      vk: 13, text: '\r' },
  tab:        { key: 'Tab',        code: 'Tab',        vk: 9,  text: '\t' },
  space:      { key: ' ',          code: 'Space',      vk: 32, text: ' ' },
  escape:     { key: 'Escape',     code: 'Escape',     vk: 27 },
  esc:        { key: 'Escape',     code: 'Escape',     vk: 27 },
  backspace:  { key: 'Backspace',  code: 'Backspace',  vk: 8 },
  delete:     { key: 'Delete',     code: 'Delete',     vk: 46 },
  arrowup:    { key: 'ArrowUp',    code: 'ArrowUp',    vk: 38 },
  arrowdown:  { key: 'ArrowDown',  code: 'ArrowDown',  vk: 40 },
  arrowleft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up:         { key: 'ArrowUp',    code: 'ArrowUp',    vk: 38 },
  down:       { key: 'ArrowDown',  code: 'ArrowDown',  vk: 40 },
  left:       { key: 'ArrowLeft',  code: 'ArrowLeft',  vk: 37 },
  right:      { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home:       { key: 'Home',       code: 'Home',       vk: 36 },
  end:        { key: 'End',        code: 'End',        vk: 35 },
  pageup:     { key: 'PageUp',     code: 'PageUp',     vk: 33 },
  pagedown:   { key: 'PageDown',   code: 'PageDown',   vk: 34 },
};

async function press({ session, key }) {
  const spec = CDP_KEYS[String(key || '').toLowerCase()];
  if (!spec) throw new Error(`unknown key "${key}" (try Enter, Tab, Escape, ArrowDown, …)`);
  const client = session.client;
  const common = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
  const down = spec.text ? { type: 'keyDown', text: spec.text, ...common } : { type: 'rawKeyDown', ...common };
  await client.Input.dispatchKeyEvent(down);
  await client.Input.dispatchKeyEvent({ type: 'keyUp', ...common });
}

module.exports = {
  name: 'cdp',
  async init() {},
  async close() {},
  click,
  select_text: selectText,
  type,
  scroll,
  press,
  navigate,
  back,
  take_screenshot: screenshot,
  save_file: saveFile,
  get_files: getFiles,
};
