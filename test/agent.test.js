'use strict';

// Agent-half tests: reduce, validate, execute (cdp backend), and the full loop
// driven by a fake provider + fake session. No Chrome and no network; launch
// tests stub CDP/process discovery rather than touching a real browser.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reduce, computeBriefHash } = require('../lib/reduce');
const { validate } = require('../lib/validate');
const registry = require('../lib/actions');
const { createExecutor } = require('../lib/execute');
const modelMod = require('../lib/model');
const { run } = require('../lib/loop');
const { loadConfig, deepMerge, DEFAULTS, ConfigError } = require('../lib/config');
const { createLogger } = require('../lib/log');
const { estimateTokens } = require('../lib/tokens');
const shared = require('../lib/providers/_shared');
const { normalizeUrl, back, clickablePoint, bestQuadRect } = require('../lib/executors/page');
const { createScratchpad, filenameStemFromHint } = require('../lib/scratchpad');
const { buildHandoff } = require('../agent');
const { buildSystemPrompt } = require('../lib/prompt');
const { collectRegions, collectPasswordIds, buildSnapshotMaps, hiddenSourceUrl, setHiddenSourceUrl } = require('../lib/extract');
const { cleanWebText, decodeHtmlEntities } = require('../lib/text');
const { markdownToHtml, markdownToHtmlDocument } = require('../lib/markdown');

// ─── tiny sequential runner ──────────────────────────────────────────────────
// Sequential matters: the loop tests share the injected fake provider, so they
// must not run concurrently.

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓', name); passed++; }
  catch (err) { console.error('  ✗', name); console.error('   ', err.stack || err.message); failed++; }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

// A fresh brief each call so refs stay valid every turn. bbox uses the array
// form to also exercise bboxArr→obj normalization.
function makeBrief(overrides = {}) {
  return {
    schemaVersion: '2.0',
    url: 'http://example.test/',
    title: 'Example',
    timestamp: '2026-01-01T00:00:00Z',
    viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0 },
    elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [100, 200, 300, 40] }],
    text: [{ ref: '@t1', role: 'heading', name: 'Welcome', bbox: [100, 50, 300, 30] }],
    lookup: { '@e1': 111, '@t1': 222 },
    stats: {},
    ...overrides,
  };
}

// Fake CDP session: records every client call so tests can assert dispatch.
function makeFakeSession(briefQueue) {
  const calls = [];
  const settleArgs = [];
  let extractCount = 0;
  const client = {
    Input: {
      dispatchMouseEvent: async (p) => { calls.push(['mouse', p]); },
      dispatchKeyEvent:   async (p) => { calls.push(['key', p]); },
      insertText:         async (p) => { calls.push(['insertText', p]); },
    },
    DOM: {
      enable: async () => {},
      getDocument: async () => {},
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }) => ({ nodeIds: backendNodeIds.map(() => 9001) }),
      focus: async (p) => { calls.push(['focus', p]); },
    },
    Runtime: {
      // selectText reads the live selection through here; return a fixed string.
      evaluate: async (p) => { calls.push(['evaluate', p]); return { result: { value: 'Selected Heading' } }; },
    },
  };
  return {
    client,
    calls,
    settleArgs,
    get extractCount() { return extractCount; },
    async extract() {
      const b = briefQueue[Math.min(extractCount, briefQueue.length - 1)];
      extractCount++;
      return typeof b === 'function' ? b() : b;   // function ⇒ fresh brief per call
    },
    async settle(opts) { settleArgs.push(opts); return 0; },
    async close() {},
  };
}

// Returns the array of `req` objects the loop sent, so tests can inspect the
// exact prompt assembled each turn.
function installFakeProvider(turns, reflectTurns = []) {
  let i = 0;   // action-queue cursor (tooled planning turns)
  let r = 0;   // reflect-queue cursor (no-tools reflection turns)
  const requests = [];
  modelMod.providers.fake = {
    name: 'fake',
    defaultModel: 'fake-1',
    async callModel(req) {
      requests.push(req);
      // A no-tools call is reflection or final report synthesis: a real provider
      // can only reply with prose, so we return text and do NOT advance the action
      // queue. Empty text models "no usable decision" for isolated guard tests.
      if (!req.tools || req.tools.length === 0) {
        const text = reflectTurns.length ? reflectTurns[Math.min(r, reflectTurns.length - 1)] : '';
        r++;
        return {
          kind: 'completion', version: '1.0', provider: 'fake', model: 'fake-1',
          raw: {}, actions: [], text, usage: {}, elapsedMs: 0,
        };
      }
      const actions = turns[Math.min(i, turns.length - 1)];
      i++;
      return {
        kind: 'completion', version: '1.0', provider: 'fake', model: 'fake-1',
        raw: {}, actions, usage: {}, elapsedMs: 0,
      };
    },
  };
  return requests;
}

let tuSeq = 0;
function action(verb, extra = {}) {
  const { args = {}, ...rest } = extra;
  return { kind: 'action', verb, args: { intent: 'test intent', ...args }, toolUseId: `tu_${verb}_${++tuSeq}`, ...rest };
}

const baseConfig = (overrides = {}) => ({
  models: {
    primary: { provider: 'fake', model: null, reasoningEffort: null, ...(overrides.primary || {}) },
    vision: { provider: 'fake', model: null, ...(overrides.vision || {}) },
    // Reflection off by default so the guard tests exercise the stuck/empty/
    // max-steps aborts in isolation; the reflection suite opts in.
    reflect: { enabled: false, provider: 'fake', model: null, ...(overrides.reflect || {}) },
    // Final report synthesis is covered explicitly; most loop tests inspect
    // planner prompts and should not add a trailing no-tools report call.
    report: { enabled: false, provider: 'fake', model: null, ...(overrides.report || {}) },
    // Step 0 off by default too: it would otherwise prepend a no-tools planning
    // call to every run and consume the reflectTurns queue. The plan suite opts in.
    plan: { enabled: false, provider: 'fake', model: null, ...(overrides.plan || {}) },
  },
  context: overrides.context ?? null,
  loop: { maxSteps: 10, shortCircuitOnNoChange: false, pollMs: 0, maxNoChangePolls: 1, maxEmptyPlans: 3, ...(overrides.loop || {}) },
  settle: { afterActionMs: 0, maxMs: 0 },
  view: { includeText: true, maxTextChars: 200, dedupeText: true },
  executor: { backend: 'cdp' },
  log: { enabled: false },
});

// ─── suites ──────────────────────────────────────────────────────────────────

async function reduceSuite() {
  console.log('\nreduce:');

  await test('interleaves @e and @t in reading order without coordinates', () => {
    const v = reduce(makeBrief(), { includeText: true });
    const lines = v.listing.split('\n');
    assert.ok(lines[0].includes('@t1'), 'heading (y=50) sorts first');
    assert.ok(lines[1].includes('@e1'), 'textbox (y=200) sorts second');
    assert.ok(!/\(\d+,\d+\)/.test(v.listing), 'no coords expected');
  });

  await test('includeText:false drops @t lines', () => {
    const v = reduce(makeBrief(), { includeText: false });
    assert.ok(!v.listing.includes('@t1'));
    assert.ok(v.listing.includes('@e1'));
  });

  await test('marks the focused element and carries url/title', () => {
    const brief = makeBrief({
      url: 'http://example.test/x',
      title: 'X',
      elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [100, 200, 300, 40], focused: true }],
    });
    const v = reduce(brief, {});
    assert.match(v.listing, /\(focused\)/, 'focused marker present');
    assert.strictEqual(v.url, 'http://example.test/x');
    assert.strictEqual(v.title, 'X');
  });

  await test('cleans noisy link URLs in the listing', () => {
    const brief = makeBrief({
      elements: [{
        ref: '@e1',
        role: 'link',
        name: 'Result',
        url: `https://example.test/path?q=keep&utm_campaign=nope&gs_lcrp=${'x'.repeat(800)}#frag`,
        bbox: [100, 200, 300, 40],
      }],
      text: [],
      lookup: { '@e1': 111 },
    });
    const listing = reduce(brief, {}).listing;
    assert.match(listing, /https:\/\/example\.test\/path\?q=keep/);
    assert.ok(!listing.includes('utm_campaign'), 'tracking param should be dropped');
    assert.ok(!listing.includes('gs_lcrp'), 'google boilerplate param should be dropped');
    assert.ok(!listing.includes('#frag'), 'fragment should be dropped');
  });

  await test('dedupeText collapses consecutive identical text', () => {
    const brief = makeBrief({
      elements: [],
      text: [
        { ref: '@t1', role: 'paragraph', name: 'Same', bbox: [0, 10, 50, 10] },
        { ref: '@t2', role: 'paragraph', name: 'Same', bbox: [0, 20, 50, 10] },
        { ref: '@t3', role: 'paragraph', name: 'Other', bbox: [0, 30, 50, 10] },
      ],
      lookup: {},
    });
    const v = reduce(brief, { dedupeText: true });
    assert.strictEqual((v.listing.match(/Same/g) || []).length, 1, 'adjacent identical collapses');
    assert.ok(v.listing.includes('Other'));
  });

  await test('bbox-less nodes do not throw and order deterministically', () => {
    const brief = makeBrief({
      elements: [{ ref: '@e1', role: 'button', name: 'A' }, { ref: '@e2', role: 'link', name: 'B' }],
      text: [], lookup: { '@e1': 1, '@e2': 2 },
    });
    assert.strictEqual(reduce(brief, {}).listing, reduce(brief, {}).listing);
  });

  await test('computeBriefHash: stable on content, ignores bbox, changes on name', () => {
    const a = makeBrief();
    assert.strictEqual(computeBriefHash(a), computeBriefHash(makeBrief()));
    const moved = makeBrief({ elements: [{ ref: '@e1', role: 'textbox', name: 'Search', bbox: [9, 9, 1, 1] }] });
    assert.strictEqual(computeBriefHash(a), computeBriefHash(moved), 'bbox excluded from hash');
    const renamed = makeBrief({ elements: [{ ref: '@e1', role: 'textbox', name: 'Find', bbox: [100, 200, 300, 40] }] });
    assert.notStrictEqual(computeBriefHash(a), computeBriefHash(renamed), 'name change busts hash');
  });

  await test('renders unreadable regions in reading order with an @r ref + crop hint', () => {
    const brief = makeBrief({
      elements: [],
      text: [{ ref: '@t1', role: 'heading', name: 'Sales', bbox: [0, 10, 100, 20] }],
      regions: [{ ref: '@r1', role: 'canvas', bbox: [0, 100, 640, 480], inViewport: true }],
    });
    const v = reduce(brief, { includeText: true });
    const lines = v.listing.split('\n');
    assert.ok(lines[0].includes('@t1'), 'heading (y=10) sorts above the canvas (y=100)');
    const region = lines.find(l => l.includes('[@r1]'));
    assert.ok(region, 'region line present with its @r ref');
    assert.ok(region.includes('canvas') && region.includes('640×480'), 'role and dimensions shown');
    assert.ok(region.includes('take_screenshot @r1'), 'points the model at a cropped screenshot of this ref');
    assert.ok(!/\(\d+,\d+\)/.test(region), 'region line omits coordinates');
  });

  await test('renders vision-enriched visuals in reading order with descriptions', () => {
    const brief = makeBrief({
      elements: [],
      text: [{ ref: '@t1', role: 'heading', name: 'Gallery', bbox: [0, 10, 100, 20] }],
      visuals: [
        { ref: '@v1', role: 'image', description: 'Photo of a black cat sitting on a blue chair', bbox: [0, 100, 640, 480], inViewport: true },
        { ref: '@v2', role: 'image', description: '   ', bbox: [0, 200, 640, 480], inViewport: true },
      ],
    });
    const lines = reduce(brief, { includeText: true }).listing.split('\n');
    assert.ok(lines[0].includes('@t1'), 'heading sorts above visual');
    const visual = lines.find(l => l.includes('[@v1]'));
    assert.ok(visual, 'visual line present with its @v ref');
    assert.ok(visual.includes('image') && visual.includes('640×480'), 'role and dimensions shown');
    assert.ok(visual.includes('"Photo of a black cat sitting on a blue chair"'), 'description shown');
    assert.ok(!lines.some(l => l.includes('[@v2]')), 'empty visual descriptions are omitted');
  });

  await test('computeBriefHash: regions bust the hash, position does not', () => {
    const without = makeBrief({ regions: [] });
    const withCanvas = makeBrief({ regions: [{ role: 'canvas', bbox: [0, 0, 10, 10], inViewport: true }] });
    assert.notStrictEqual(computeBriefHash(without), computeBriefHash(withCanvas), 'gaining a region re-prompts');
    const moved = makeBrief({ regions: [{ role: 'canvas', bbox: [500, 500, 10, 10], inViewport: true }] });
    assert.strictEqual(computeBriefHash(withCanvas), computeBriefHash(moved), 'region bbox excluded from hash');
  });

  await test('computeBriefHash: visual descriptions bust the hash, position does not', () => {
    const withVisual = makeBrief({ visuals: [{ ref: '@v1', role: 'image', description: 'Cat photo', bbox: [0, 0, 10, 10], inViewport: true }] });
    const moved = makeBrief({ visuals: [{ ref: '@v1', role: 'image', description: 'Cat photo', bbox: [500, 500, 10, 10], inViewport: true }] });
    assert.strictEqual(computeBriefHash(withVisual), computeBriefHash(moved), 'visual bbox excluded from hash');
    const changed = makeBrief({ visuals: [{ ref: '@v1', role: 'image', description: 'Dog photo', bbox: [0, 0, 10, 10], inViewport: true }] });
    assert.notStrictEqual(computeBriefHash(withVisual), computeBriefHash(changed), 'description change busts hash');
  });

  await test('collapses internal whitespace so a multi-line name stays on one line', () => {
    const brief = makeBrief({
      // a wrapped button label / alt text with hard line breaks and tabs
      elements: [{ ref: '@e1', role: 'button', name: 'Add\n   to\t cart', bbox: [10, 10, 80, 30] }],
      text: [{ ref: '@t1', role: 'paragraph', name: 'line one\nline two', bbox: [10, 60, 200, 40] }],
      lookup: { '@e1': 1, '@t1': 2 },
    });
    const listing = reduce(brief, { includeText: true }).listing;
    assert.strictEqual(listing.split('\n').length, 2, 'two nodes ⇒ exactly two lines (no embedded newline)');
    assert.ok(listing.includes('"Add to cart"'), 'whitespace runs collapse to single spaces');
    assert.ok(listing.includes('"line one line two"'), 'text node names collapse too');
  });

  await test('truncates an over-long interactive name (stretched-link cards)', () => {
    const long = 'x'.repeat(500);
    const brief = makeBrief({
      elements: [{ ref: '@e1', role: 'link', name: long, bbox: [10, 10, 80, 30] }],
      text: [], lookup: { '@e1': 1 },
    });
    const line = reduce(brief, { includeText: false, maxTextChars: 200 }).listing;
    assert.ok(line.includes('…'), 'long name is ellipsized');
    assert.ok(line.length < long.length, 'rendered line is shorter than the raw name');
  });

  await test('surfaces required and invalid form-field states', () => {
    const brief = makeBrief({
      elements: [{ ref: '@e1', role: 'textbox', name: 'Email', required: true, invalid: true, bbox: [10, 10, 200, 30] }],
      text: [], lookup: { '@e1': 1 },
    });
    const listing = reduce(brief, { includeText: false }).listing;
    assert.match(listing, /\(required\)/, 'required marker present');
    assert.match(listing, /\(invalid\)/, 'invalid marker present');
  });

  await test('does not flag the AX "false" invalid token (full-mode raw value)', () => {
    // full-mode briefs carry the raw AX token; "false" is a truthy string and
    // must NOT render as (invalid).
    const brief = makeBrief({
      elements: [{ ref: '@e1', role: 'textbox', name: 'Email', invalid: 'false', bbox: [10, 10, 200, 30] }],
      text: [], lookup: { '@e1': 1 },
    });
    assert.ok(!reduce(brief, { includeText: false }).listing.includes('(invalid)'), '"false" token is not invalid');
  });

  await test('marks a popup-opening control, and an element below the fold with ↓', () => {
    const brief = makeBrief({
      elements: [
        { ref: '@e1', role: 'button', name: 'Account', haspopup: 'menu', bbox: [10, 10, 80, 30], inViewport: true },
        { ref: '@e2', role: 'button', name: 'Load more', bbox: [10, 1500, 80, 30], inViewport: false },
      ],
      text: [], lookup: { '@e1': 1, '@e2': 2 },
    });
    const lines = reduce(brief, { includeText: false }).listing.split('\n');
    const account = lines.find(l => l.includes('@e1'));
    const loadMore = lines.find(l => l.includes('@e2'));
    assert.match(account, /\(opens menu\)/, 'haspopup token rendered in plain language');
    assert.ok(!account.endsWith('↓'), 'on-screen element gets no fold marker');
    assert.ok(loadMore.endsWith('↓'), 'below-fold element marked with ↓');
  });

  await test('haspopup: "listbox" reads as "opens list", "dialog" as "opens dialog", "false" shows nothing', () => {
    const brief = makeBrief({
      elements: [
        { ref: '@e1', role: 'combobox', name: 'State', haspopup: 'listbox', bbox: [10, 10, 80, 30] },
        { ref: '@e2', role: 'button', name: 'Settings', haspopup: 'dialog', bbox: [10, 50, 80, 30] },
        { ref: '@e3', role: 'button', name: 'Plain', haspopup: 'false', bbox: [10, 90, 80, 30] },
      ],
      text: [], lookup: { '@e1': 1, '@e2': 2, '@e3': 3 },
    });
    const listing = reduce(brief, { includeText: false }).listing;
    assert.match(listing, /\(opens list\)/);
    assert.match(listing, /\(opens dialog\)/);
    assert.ok(!/Plain.*opens/.test(listing), '"false" haspopup opens nothing');
  });
}

// Build a one-document DOMSnapshot from a compact node spec. Each node is
// { tag, parent, backend, attrs?: {name:val}, bounds?: [x,y,w,h], style?: {} }.
// Strings are interned into the shared table the way captureSnapshot returns them.
const SNAPSHOT_STYLE_PROPS = [
  'cursor', 'display', 'visibility', 'opacity', 'pointer-events',
  'position', 'z-index', 'background-color', 'background-image',
  'background-repeat', 'color',
  'font-size', 'font-weight', 'border-radius', 'overflow',
];

function makeSnapshot(nodeSpecs) {
  const strings = [];
  const intern = (s) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const nodeName = [], parentIndex = [], backendNodeId = [], attributes = [];
  const layoutNodeIndex = [], bounds = [], styles = [];
  const cdIndex = [];   // contentDocumentIndex.index — iframes with an embedded (same-process) doc
  nodeSpecs.forEach((n, i) => {
    nodeName.push(intern(n.tag));
    parentIndex.push(n.parent ?? -1);
    backendNodeId.push(n.backend);
    const flat = [];
    for (const [k, val] of Object.entries(n.attrs || {})) { flat.push(intern(k)); flat.push(intern(String(val))); }
    attributes.push(flat);
    if (n.bounds) {
      layoutNodeIndex.push(i);
      bounds.push(n.bounds);
      styles.push(SNAPSHOT_STYLE_PROPS.map(prop => prop in (n.style || {}) ? intern(String(n.style[prop])) : -1));
    }
    if (n.contentDoc) cdIndex.push(i);
  });
  return {
    strings,
    documents: [{
      nodes: { nodeName, parentIndex, backendNodeId, attributes, contentDocumentIndex: { index: cdIndex, value: cdIndex.map(() => 0) } },
      layout: { nodeIndex: layoutNodeIndex, bounds, styles },
    }],
  };
}

async function regionSuite() {
  console.log('\ncollectRegions:');
  const viewport = { width: 1000, height: 2000, scrollX: 0, scrollY: 0 };

  await test('surfaces unnamed canvas/img; skips named, hidden, nested, titled, zero-size', () => {
    const snapshot = makeSnapshot([
      { tag: 'DIV',    parent: -1, backend: 100 },
      { tag: 'CANVAS', parent: 0,  backend: 101, bounds: [10, 10, 200, 100] },               // ✓ unnamed canvas
      { tag: 'IMG',    parent: 0,  backend: 102, attrs: { alt: 'product' }, bounds: [10, 120, 50, 50] }, // ✗ alt present
      { tag: 'IMG',    parent: 0,  backend: 103, bounds: [10, 180, 50, 50] },                // ✓ alt-less img
      { tag: 'BUTTON', parent: 0,  backend: 104, bounds: [10, 240, 40, 40] },
      { tag: 'svg',    parent: 4,  backend: 105, bounds: [12, 242, 16, 16] },                // ✗ icon inside button
      { tag: 'svg',    parent: 0,  backend: 106, bounds: [10, 300, 80, 80] },                // ✗ has <title> child
      { tag: 'title',  parent: 6,  backend: 107 },
      { tag: 'CANVAS', parent: 0,  backend: 108, attrs: { 'aria-hidden': 'true' }, bounds: [10, 400, 300, 200] }, // ✗ aria-hidden
      { tag: 'CANVAS', parent: 0,  backend: 109, bounds: [10, 620, 0, 0] },                  // ✗ zero-area
    ]);
    const maps = buildSnapshotMaps(snapshot);
    const regions = collectRegions(snapshot, maps, viewport, {});
    assert.deepStrictEqual(regions.map(r => r.role), ['canvas', 'image'], 'only the two unnamed graphics surface');
    assert.deepStrictEqual(regions[0].bbox, { x: 10, y: 10, width: 200, height: 100 }, 'canvas bbox in CSS px');
    assert.strictEqual(regions[0].inViewport, true);
    assert.strictEqual(regions[0].backendNodeId, 101, 'carries node id for lookup + crop');
    assert.strictEqual(regions[1].backendNodeId, 103);
  });

  await test('cross-origin iframe (no embedded doc) → an iframe region; same-origin does not', () => {
    const snapshot = makeSnapshot([
      { tag: 'DIV',    parent: -1, backend: 300 },
      { tag: 'IFRAME', parent: 0,  backend: 301, bounds: [0, 0, 400, 300] },                                  // ✓ cross-origin: no content doc in snapshot
      { tag: 'IFRAME', parent: 0,  backend: 302, bounds: [0, 320, 400, 300], contentDoc: true },              // ✗ same-origin: doc embedded + already extracted
      { tag: 'IFRAME', parent: 0,  backend: 303, attrs: { 'aria-hidden': 'true' }, bounds: [0, 700, 400, 300] }, // ✗ hidden from a11y
    ]);
    const maps = buildSnapshotMaps(snapshot);
    const regions = collectRegions(snapshot, maps, viewport, {});
    assert.deepStrictEqual(regions.map(r => r.role), ['iframe'], 'only the cross-origin iframe surfaces');
    assert.strictEqual(regions[0].backendNodeId, 301);
  });

  await test('aria-label names a graphic; inViewportOnly drops off-screen regions', () => {
    const snapshot = makeSnapshot([
      { tag: 'CANVAS', parent: -1, backend: 200, attrs: { 'aria-label': 'Revenue chart' }, bounds: [0, 0, 100, 100] }, // ✗ named
      { tag: 'CANVAS', parent: -1, backend: 201, bounds: [0, 5000, 100, 100] },              // off-screen (y beyond viewport)
    ]);
    const maps = buildSnapshotMaps(snapshot);
    assert.strictEqual(collectRegions(snapshot, maps, viewport, {}).length, 1, 'off-screen still listed without the filter');
    assert.strictEqual(collectRegions(snapshot, maps, viewport, { inViewportOnly: true }).length, 0, 'inViewportOnly drops it');
  });

  await test('surfaces URL-backed CSS backgrounds and filters layout/control backgrounds', () => {
    const snapshot = makeSnapshot([
      { tag: 'DIV', parent: -1, backend: 400 },
      { tag: 'DIV', parent: 0, backend: 401, bounds: [10, 10, 100, 100], style: {
        'background-image': 'url("https://cdn.test/profile.jpg")',
        'background-repeat': 'no-repeat',
      } }, // ✓ profile/photo-style CSS image
      { tag: 'DIV', parent: 0, backend: 402, bounds: [10, 130, 100, 100], style: {
        'background-image': 'url("https://cdn.test/tile.png")',
        'background-repeat': 'repeat',
      } }, // ✗ true repeating background
      { tag: 'BUTTON', parent: 0, backend: 403, bounds: [10, 250, 100, 100], style: {
        'background-image': 'url("https://cdn.test/icon.png")',
        'background-repeat': 'no-repeat',
      } }, // ✗ control background/icon
      { tag: 'DIV', parent: 0, backend: 404, bounds: [10, 370, 24, 24], style: {
        'background-image': 'url("https://cdn.test/tiny.png")',
        'background-repeat': 'no-repeat',
      } }, // ✗ tiny icon-ish background
      { tag: 'DIV', parent: 0, backend: 405, bounds: [10, 430, 100, 100], style: {
        'background-image': 'linear-gradient(red, blue)',
        'background-repeat': 'no-repeat',
      } }, // ✗ no URL
    ]);
    const maps = buildSnapshotMaps(snapshot);
    const regions = collectRegions(snapshot, maps, viewport, {});
    assert.deepStrictEqual(regions.map(r => r.role), ['image']);
    assert.strictEqual(regions[0].backendNodeId, 401);
    assert.strictEqual(hiddenSourceUrl(regions[0]), 'https://cdn.test/profile.jpg');
    assert.ok(!Object.keys(regions[0]).includes('__browserAgentSourceUrl'), 'source URL stays out of serialized region metadata');
  });

  await test('collectPasswordIds: finds <input type=password>, ignores other inputs/tags', () => {
    const snapshot = makeSnapshot([
      { tag: 'INPUT', parent: -1, backend: 1, attrs: { type: 'password' } },  // ✓ password
      { tag: 'INPUT', parent: -1, backend: 2, attrs: { type: 'text' } },      // ✗ text input
      { tag: 'INPUT', parent: -1, backend: 3 },                               // ✗ no type
      { tag: 'DIV',   parent: -1, backend: 4, attrs: { type: 'password' } },  // ✗ not an input
    ]);
    const ids = collectPasswordIds(snapshot);
    assert.ok(ids.has(1), 'password input is collected');
    assert.ok(!ids.has(2) && !ids.has(3) && !ids.has(4), 'everything else is excluded');
  });
}

async function screenshotSuite() {
  console.log('\nscreenshot (crop):');
  const { screenshot } = require('../lib/screenshot');
  const visionMod = require('../lib/vision');
  const origDescribe = visionMod.describe;
  visionMod.describe = async () => ({ summary: 'short view', description: 'a description' });   // no network/LLM in unit tests

  const fakeSession = () => {
    const calls = [];
    return { calls, client: { Page: { captureScreenshot: async (p) => { calls.push(p); return { data: 'BASE64PNG' }; } } } };
  };

  try {
    await test('no ref → whole viewport, no clip', async () => {
      const s = fakeSession();
      const out = await screenshot({ session: s, brief: makeBrief() });
      assert.strictEqual(s.calls[0].clip, undefined, 'no clip param');
      assert.strictEqual(s.calls[0].captureBeyondViewport, undefined);
      assert.strictEqual(out.cropped, false);
    });

    await test('region ref → clip from its bbox, captureBeyondViewport on (off-screen ok)', async () => {
      const s = fakeSession();
      const brief = makeBrief({
        regions: [{ ref: '@r1', role: 'canvas', bbox: { x: 5, y: 600, width: 640, height: 480 }, inViewport: false }],
      });
      const out = await screenshot({ session: s, brief, ref: '@r1' });
      assert.deepStrictEqual(s.calls[0].clip, { x: 5, y: 600, width: 640, height: 480, scale: 1 });
      assert.strictEqual(s.calls[0].captureBeyondViewport, true, 'off-screen graphic captured without scrolling');
      assert.strictEqual(out.cropped, true);
      assert.strictEqual(out.ref, '@r1');
    });

    await test('element ref with array bbox is normalized to a clip', async () => {
      const s = fakeSession();
      const out = await screenshot({ session: s, brief: makeBrief(), ref: '@e1' });  // bbox [100,200,300,40]
      assert.deepStrictEqual(s.calls[0].clip, { x: 100, y: 200, width: 300, height: 40, scale: 1 });
      assert.strictEqual(out.cropped, true);
    });

    await test('unknown/boxless ref degrades to a full-viewport capture', async () => {
      const s = fakeSession();
      const out = await screenshot({ session: s, brief: makeBrief(), ref: '@r9' });
      assert.strictEqual(s.calls[0].clip, undefined);
      assert.strictEqual(out.cropped, false);
    });

    await test('quality tiers by ref: a cropped read is higher quality than a describe', async () => {
      const s1 = fakeSession();
      const out1 = await screenshot({ session: s1, brief: makeBrief() });   // no ref → describe
      const s2 = fakeSession();
      const brief = makeBrief({ regions: [{ ref: '@r1', role: 'canvas', bbox: { x: 0, y: 0, width: 100, height: 100 }, inViewport: true }] });
      const out2 = await screenshot({ session: s2, brief, ref: '@r1' });     // ref → cropped read
      assert.strictEqual(s1.calls[0].format, 'jpeg');
      assert.strictEqual(s2.calls[0].format, 'jpeg');
      assert.ok(s2.calls[0].quality > s1.calls[0].quality, 'cropped read encoded at higher quality than a full-page describe');
      assert.strictEqual(out1.mimeType, 'image/jpeg');
      assert.strictEqual(out1.ext, 'jpg');
    });
  } finally {
    visionMod.describe = origDescribe;
  }
}

async function visionSuite() {
  console.log('\nvision:');
  const { normalizeVisionResult, normalizeVisualEvidenceResult } = require('../lib/vision');

  await test('normalizes typed JSON into summary + description', () => {
    const out = normalizeVisionResult('{"summary":"short page summary","description":"full page description"}');
    assert.deepStrictEqual(out, { summary: 'short page summary', description: 'full page description' });
  });

  await test('falls back to a ten-word summary for non-JSON vision text', () => {
    const out = normalizeVisionResult('one two three four five six seven eight nine ten eleven twelve');
    assert.strictEqual(out.summary, 'one two three four five six seven eight nine ten');
    assert.strictEqual(out.description, 'one two three four five six seven eight nine ten eleven twelve');
  });

  await test('normalizes visual evidence classification JSON', () => {
    assert.deepStrictEqual(
      normalizeVisualEvidenceResult('{"kind":"visual","description":"A useful chart","text":""}'),
      { kind: 'visual', description: 'A useful chart', text: '' },
    );
    assert.deepStrictEqual(
      normalizeVisualEvidenceResult({ kind: 'text', description: '', text: 'Total revenue: $10M' }),
      { kind: 'text', description: '', text: 'Total revenue: $10M' },
    );
    assert.deepStrictEqual(
      normalizeVisualEvidenceResult('{"kind":"unknown","description":"white box","text":""}'),
      { kind: 'unknown', description: 'white box', text: '' },
    );
    assert.deepStrictEqual(
      normalizeVisualEvidenceResult('not json'),
      { kind: 'unknown', description: '', text: '' },
    );
  });
}

async function visualEnrichmentSuite() {
  console.log('\nvisual enrichment:');
  const visionMod = require('../lib/vision');
  const {
    enrichVisualEvidence,
    getCachedVisualImage,
    clearVisualEvidenceCache,
  } = require('../lib/visual_enrichment');

  function sessionReturning(base64 = Buffer.from('crop').toString('base64')) {
    const calls = [];
    return {
      calls,
      client: {
        Page: {
          captureScreenshot: async (params) => {
            calls.push(params);
            return { data: base64 };
          },
        },
      },
    };
  }

  await test('turns classified regions into @v, derived @t, or omission', async () => {
    clearVisualEvidenceCache();
    const origClassify = visionMod.classifyVisualEvidence;
    const base64 = Buffer.from('visual crop').toString('base64');
    const outputs = [
      { kind: 'visual', description: 'Photo of a black cat', text: '' },
      { kind: 'text', description: '', text: 'Revenue grew 25%' },
      { kind: 'unknown', description: 'blank white box', text: '' },
    ];
    visionMod.classifyVisualEvidence = async () => outputs.shift();
    try {
      const brief = makeBrief({
        elements: [],
        text: [{ ref: '@t1', role: 'heading', name: 'Report', bbox: [0, 0, 100, 20] }],
        regions: [
          { ref: '@r1', role: 'image', bbox: { x: 0, y: 40, width: 100, height: 100 }, inViewport: true },
          { ref: '@r2', role: 'canvas', bbox: { x: 0, y: 160, width: 90, height: 100 }, inViewport: true },
          { ref: '@r3', role: 'svg', bbox: { x: 0, y: 280, width: 80, height: 100 }, inViewport: true },
        ],
        lookup: { '@t1': 1, '@r1': 11, '@r2': 22, '@r3': 33 },
      });
      const session = sessionReturning(base64);
      await enrichVisualEvidence({ session, brief, rawHash: 'raw', config: { enabled: true, maxRegions: 8 } });

      assert.deepStrictEqual(brief.regions, [], 'all classified @r nodes are removed from the raw region list');
      assert.strictEqual(brief.visuals.length, 1);
      assert.strictEqual(brief.visuals[0].ref, '@v1');
      assert.strictEqual(brief.visuals[0].description, 'Photo of a black cat');
      assert.strictEqual(brief.visuals[0].sourceRef, '@r1');
      assert.strictEqual(brief.text[1].ref, '@t2');
      assert.strictEqual(brief.text[1].name, 'Revenue grew 25%');
      assert.strictEqual(brief.text[1].derived, 'vision');
      assert.deepStrictEqual(brief.lookup, { '@t1': 1, '@v1': 11, '@t2': 22 });
      assert.strictEqual(session.calls.length, 3, 'one cropped capture per analyzed region');

      const cached = getCachedVisualImage(brief, '@v1');
      assert.strictEqual(cached.image, base64);
      assert.ok(!Object.keys(brief).some(k => k.includes('VisualCache')), 'image cache is non-enumerable');
      assert.ok(!JSON.stringify(brief).includes(base64), 'image bytes do not serialize with the brief');
    } finally {
      visionMod.classifyVisualEvidence = origClassify;
      clearVisualEvidenceCache();
    }
  });

  await test('keeps @r fallback when capture or vision fails', async () => {
    clearVisualEvidenceCache();
    const origClassify = visionMod.classifyVisualEvidence;
    visionMod.classifyVisualEvidence = async () => { throw new Error('vision timeout'); };
    try {
      const brief = makeBrief({
        elements: [],
        text: [],
        regions: [{ ref: '@r1', role: 'canvas', bbox: { x: 0, y: 0, width: 100, height: 100 }, inViewport: true }],
        lookup: { '@r1': 11 },
      });
      await enrichVisualEvidence({ session: sessionReturning(), brief, rawHash: 'raw', config: { enabled: true, maxRegions: 8 } });
      assert.strictEqual(brief.regions.length, 1);
      assert.strictEqual(brief.regions[0].ref, '@r1');
      assert.strictEqual(brief.lookup['@r1'], 11);
    } finally {
      visionMod.classifyVisualEvidence = origClassify;
      clearVisualEvidenceCache();
    }
  });
}

async function osGateSuite() {
  console.log('\nos backend (input gate):');
  const { ensureInputSafe, pageToScreen } = require('../lib/executors/os');

  // Minimal fake of the browser-input helper client: send() answers the gate
  // probes. Deliberately NO `Page` domain — the real helper is a JSON-RPC client
  // over the Swift binary, not a CDP client, so ensureInputSafe must never reach
  // for `.Page` (foregrounding lives in pageToScreen, which holds the CDP client).
  const fakeClient = (overrides = {}) => ({
    idleGuard: { enabled: false, thresholdMs: 0 },
    send: async ({ op }) => (op === 'frontapp' ? { bundleId: 'com.google.Chrome' } : {}),
    ...overrides,
  });

  await test('passes once Chrome is frontmost, using only the helper protocol (no CDP Page)', async () => {
    const calls = [];
    const client = fakeClient({
      send: async ({ op }) => { calls.push(op); return op === 'frontapp' ? { bundleId: 'com.google.Chrome' } : {}; },
    });
    await ensureInputSafe(client);   // must resolve without ever touching client.Page
    assert.ok(calls.includes('frontapp'), 'checked Chrome is frontmost');
  });

  await test('aborts (wait:false) when Chrome is not the frontmost app', async () => {
    const client = fakeClient({
      send: async ({ op }) => (op === 'frontapp' ? { bundleId: 'com.apple.Terminal', name: 'Terminal' } : {}),
    });
    await assert.rejects(() => ensureInputSafe(client, { wait: false }), /not the frontmost app/);
  });

  // Foregrounding the followed tab moved here from the input gate: pageToScreen
  // holds the CDP client (session.client, with a real Page domain), so this is
  // where the pinned target's window is actually raised before input lands.
  const screenSession = (over = {}) => ({
    _target: { id: 'T1' },
    client: {
      Page: {
        bringToFront: over.bringToFront || (async () => {}),
        getLayoutMetrics: async () => ({
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800 },
          cssVisualViewport: { clientWidth: 1000, clientHeight: 800 },
        }),
      },
      Target: { getTargets: async () => ({ targetInfos: [{ targetId: 'T1', type: 'page' }] }) },
      Browser: {
        getWindowForTarget: async () => ({ windowId: 1 }),
        getWindowBounds: async () => ({ bounds: { left: 0, top: 0, width: 1000, height: 900 } }),
      },
    },
  });

  await test('pageToScreen raises the pinned target window before converting coords', async () => {
    let raised = false;
    const session = screenSession({ bringToFront: async () => { raised = true; } });
    await pageToScreen(session, 100, 100, { viewportRelative: true });
    assert.ok(raised, 'brought the pinned target window to front so input lands on it');
  });

  await test('pageToScreen still maps coords when the raise fails (best-effort)', async () => {
    const session = screenSession({ bringToFront: async () => { throw new Error('detached target'); } });
    const screen = await pageToScreen(session, 100, 100, { viewportRelative: true });
    assert.ok(Number.isFinite(screen.x) && Number.isFinite(screen.y), 'coordinate mapping proceeds despite a failed raise');
  });

  await test('pageToScreen falls back when native viewport origin is unavailable', async () => {
    const session = screenSession();
    const inputClient = { send: async () => { throw new Error('old helper'); } };
    const screen = await pageToScreen(session, 100, 100, { viewportRelative: true, inputClient });
    assert.deepStrictEqual(screen, { x: 100, y: 200 });
  });

  if (process.platform === 'darwin') {
    await test('pageToScreen prefers macOS AXWebArea origin when available', async () => {
      const session = screenSession();
      const inputClient = { send: async ({ op }) => {
        assert.strictEqual(op, 'webarea');
        return { x: 10, y: 20, width: 1000, height: 800, source: 'macos-ax-webarea' };
      } };
      const screen = await pageToScreen(session, 100, 100, { viewportRelative: true, inputClient });
      assert.deepStrictEqual(screen, { x: 110, y: 120 });
    });
  }
}

async function validateSuite() {
  console.log('\nvalidate:');

  await test('accepts well-formed click/type/scroll/press/wait/done', () => {
    const { ok, errors } = validate([
      action('click', { ref: '@e1' }),
      action('type', { ref: '@e1', args: { text: 'hi' } }),
      action('scroll', { args: { direction: 'down' } }),
      action('press', { args: { key: 'Enter' } }),
      action('wait', { args: { ms: 10 } }),
      action('done', { args: {} }),
    ], { '@e1': 111 }, registry);
    assert.strictEqual(errors.length, 0, JSON.stringify(errors));
    assert.strictEqual(ok.length, 6);
  });

  await test('click accepts both @e and @t targets', () => {
    const lookup = { '@e1': 111, '@t1': 222 };
    const { ok, errors } = validate([
      action('click', { ref: '@e1' }),
      action('click', { ref: '@t1' }),
    ], lookup, registry);
    assert.strictEqual(errors.length, 0, JSON.stringify(errors));
    assert.strictEqual(ok.length, 2);
  });

  await test('rejects wrong ref type, unknown verb, missing arg, bad/absent ref', () => {
    const lookup = { '@e1': 111, '@t1': 222 };
    const cases = [
      [action('type', { ref: '@t1', args: { text: 'x' } }), /requires ref type/],  // type is @e-only
      [action('frobnicate', { ref: '@e1' }), /unknown verb/],
      [action('type', { ref: '@e1', args: {} }), /missing required arg "text"/],
      [action('click', { ref: '@e9' }), /not present in current snapshot/],
      [action('scroll', { args: {} }), /missing required arg "direction"/],
      [action('wait', { args: {} }), /missing required arg "ms"/],
    ];
    for (const [act, re] of cases) {
      const { ok, errors } = validate([act], lookup, registry);
      assert.strictEqual(ok.length, 0);
      assert.match(errors[0].error, re);
    }
  });

  await test('requires a non-empty intent under 15 words', () => {
    const lookup = { '@e1': 111 };
    const cases = [
      [action('click', { ref: '@e1', args: { intent: undefined } }), /missing required arg "intent"/],
      [action('click', { ref: '@e1', args: { intent: '   ' } }), /must not be empty/],
      [action('click', { ref: '@e1', args: { intent: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' } }), /under 15 words/],
    ];
    for (const [act, re] of cases) {
      const { ok, errors } = validate([act], lookup, registry);
      assert.strictEqual(ok.length, 0);
      assert.match(errors[0].error, re);
    }
  });

  await test('tolerates extra args', () => {
    const { ok } = validate([action('press', { args: { key: 'Enter', bogus: 1 } })], {}, registry);
    assert.strictEqual(ok.length, 1);
  });

  await test('take_screenshot: optional ref — accepts @e/@t/@r, valid with none', () => {
    const lookup = { '@e1': 111, '@t1': 222, '@r1': 333 };
    for (const ref of ['@e1', '@t1', '@r1']) {
      const { ok, errors } = validate([action('take_screenshot', { ref })], lookup, registry);
      assert.strictEqual(ok.length, 1, `${ref} accepted: ${JSON.stringify(errors)}`);
    }
    const { ok } = validate([action('take_screenshot')], lookup, registry);
    assert.strictEqual(ok.length, 1, 'no ref is valid — full-viewport capture');
  });

  await test('save_image accepts optional @e/@t/@r/@v refs', () => {
    const lookup = { '@e1': 111, '@t1': 222, '@r1': 333, '@v1': 444 };
    for (const ref of ['@e1', '@t1', '@r1', '@v1']) {
      const { ok, errors } = validate([action('save_image', { ref })], lookup, registry);
      assert.strictEqual(ok.length, 1, `${ref} accepted: ${JSON.stringify(errors)}`);
    }
    assert.strictEqual(validate([action('save_image')], lookup, registry).ok.length, 1, 'no ref saves viewport');
    const rejected = validate([action('save_image', { ref: '@v9' })], lookup, registry);
    assert.strictEqual(rejected.ok.length, 0);
    assert.match(rejected.errors[0].error, /not present in current snapshot/);
  });

  await test('take_screenshot: a present-but-unknown ref is rejected', () => {
    const { ok, errors } = validate([action('take_screenshot', { ref: '@r9' })], { '@r1': 333 }, registry);
    assert.strictEqual(ok.length, 0);
    assert.match(errors[0].error, /not present in current snapshot/);
  });

  await test('only visual read/save actions accept an @r ref; click/select_text reject it', () => {
    const lookup = { '@r1': 333 };
    for (const verb of ['click', 'select_text']) {
      const { ok, errors } = validate([action(verb, { ref: '@r1' })], lookup, registry);
      assert.strictEqual(ok.length, 0, `${verb} must reject @r`);
      assert.match(errors[0].error, /requires ref type/);
    }
  });

  await test('malformed action records an error instead of throwing', () => {
    const { ok, errors } = validate([null, 'bad'], {}, registry);
    assert.strictEqual(ok.length, 0);
    assert.strictEqual(errors.length, 2);
    assert.match(errors[0].error, /action must be an object/);
  });

  await test('non-array actions payload records an error instead of throwing', () => {
    const { ok, errors } = validate({ verb: 'done', args: {} }, {}, registry);
    assert.strictEqual(ok.length, 0);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].error, /actions must be an array/);
  });
}

async function executeSuite() {
  console.log('\nexecute (cdp):');

  await test('click dispatches mouse at bbox-center minus scroll', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 0, maxMs: 0 });
    const [obs] = await exec.execute([action('click', { ref: '@e1' })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const moves = session.calls.filter(c => c[0] === 'mouse');
    assert.strictEqual(moves.length, 3, 'move/press/release');
    assert.strictEqual(moves[0][1].x, 250);  // 100 + 300/2
    assert.strictEqual(moves[0][1].y, 220);  // 200 + 40/2
  });

  await test('click on a @t text node dispatches mouse at its bbox center', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 0, maxMs: 0 });
    const [obs] = await exec.execute([action('click', { ref: '@t1' })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const moves = session.calls.filter(c => c[0] === 'mouse');
    assert.strictEqual(moves.length, 3, 'move/press/release');
    assert.strictEqual(moves[0][1].x, 250);  // @t1 bbox [100,50,300,30] → 100 + 300/2
    assert.strictEqual(moves[0][1].y, 65);   // 50 + 30/2
  });

  await test('type focuses via pushed nodeId then insertText', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('type', { ref: '@e1', args: { text: 'hello' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    assert.ok(session.calls.some(c => c[0] === 'focus' && c[1].nodeId === 9001));
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hello'));
  });

  await test('press Enter dispatches keyDown+keyUp', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('press', { args: { key: 'Enter' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const keys = session.calls.filter(c => c[0] === 'key');
    assert.strictEqual(keys.length, 2);
    assert.strictEqual(keys[0][1].type, 'keyDown');
    assert.strictEqual(keys[0][1].key, 'Enter');
    assert.strictEqual(keys[1][1].type, 'keyUp');
  });

  await test('scroll down dispatches a positive-deltaY wheel at viewport center', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('scroll', { args: { direction: 'down' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    const wheel = session.calls.find(c => c[0] === 'mouse' && c[1].type === 'mouseWheel');
    assert.ok(wheel, 'expected a mouseWheel event');
    assert.ok(wheel[1].deltaY > 0, 'down scrolls with positive deltaY');
    assert.strictEqual(wheel[1].x, 500);
    assert.strictEqual(wheel[1].y, 400);
  });

  await test('unknown scroll direction is an error observation with no wheel dispatch', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('scroll', { args: { direction: 'sideways' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'error');
    assert.match(obs.error, /unknown scroll direction/);
    assert.ok(!session.calls.some(c => c[0] === 'mouse' && c[1].type === 'mouseWheel'));
  });

  await test('done is ok with no dispatch and no settle', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('done', { args: { result: 'x' } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok');
    assert.strictEqual(session.calls.length, 0, 'done dispatches nothing');
    assert.strictEqual(session.settleArgs.length, 0, 'done does not settle');
  });

  await test('wait sleeps without backend dispatch and still settles', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 0, maxMs: 0 });
    const [obs] = await exec.execute([action('wait', { args: { ms: 1 } })], session, makeBrief());
    assert.strictEqual(obs.status, 'ok', obs.error);
    assert.deepStrictEqual(obs.detail, { waitedMs: 1 });
    assert.strictEqual(session.calls.length, 0, 'wait dispatches no backend input');
    assert.deepStrictEqual(session.settleArgs[0], { afterActionMs: 0, maxMs: 0 });
  });

  await test('wait rejects unreasonable durations', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('wait', { args: { ms: 30001 } })], session, makeBrief());
    assert.strictEqual(obs.status, 'error');
    assert.match(obs.error, /wait\.ms/);
    assert.strictEqual(session.settleArgs.length, 0, 'rejected wait does not settle');
  });

  await test('settle receives the run settle config', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, { afterActionMs: 321, maxMs: 999 });
    await exec.execute([action('press', { args: { key: 'Tab' } })], session, makeBrief());
    assert.deepStrictEqual(session.settleArgs[0], { afterActionMs: 321, maxMs: 999 });
  });

  await test('invalid ref yields an error observation, not a throw', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    const [obs] = await exec.execute([action('click', { ref: '@e9' })], session, makeBrief());
    assert.strictEqual(obs.status, 'error');
    assert.match(obs.error, /not found in brief/);
  });
}

async function targetingSuite() {
  console.log('\nclick targeting & hit-test:');

  // A CDP client that serves content quads + layout metrics, for the precise
  // (non-fallback) clickablePoint path.
  function quadSession({ quads, layout }) {
    return {
      client: {
        DOM: {
          enable: async () => {},
          getDocument: async () => {},
          scrollIntoViewIfNeeded: async () => {},
          getContentQuads: async () => ({ quads }),
        },
        Page: { getLayoutMetrics: async () => layout },
      },
    };
  }
  const layout1k = { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800 } };

  await test('bestQuadRect picks the largest viewport-visible quad', () => {
    const small = [0, 0, 20, 0, 20, 20, 0, 20];        // 20×20 at origin
    const big   = [100, 100, 400, 100, 400, 300, 100, 300]; // 300×200
    const r = bestQuadRect([small, big], 1000, 800);
    assert.deepStrictEqual(r, { x: 100, y: 100, width: 300, height: 200 });
  });

  await test('bestQuadRect clamps a quad to the visible viewport', () => {
    const offBottom = [0, 700, 200, 700, 200, 1200, 0, 1200]; // extends past vh=800
    const r = bestQuadRect([offBottom], 1000, 800);
    assert.deepStrictEqual(r, { x: 0, y: 700, width: 200, height: 100 });
  });

  await test('clickablePoint aims at the content-quad center (viewport coords)', async () => {
    const quad = [10, 10, 110, 10, 110, 50, 10, 50]; // rect x10 y10 w100 h40
    const session = quadSession({ quads: [quad], layout: layout1k });
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.strictEqual(pt.source, 'quad');
    assert.strictEqual(pt.x, 60);  // 10 + 100/2
    assert.strictEqual(pt.y, 30);  // 10 + 40/2
  });

  await test('clickablePoint falls back to bbox center when quads unavailable', async () => {
    // No Page domain ⇒ precise path is skipped, bbox-center fallback is used.
    const session = { client: { DOM: { enable: async () => {}, getDocument: async () => {} } } };
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.strictEqual(pt.source, 'bbox');
    assert.strictEqual(pt.x, 250); // 100 + 300/2 - scroll(0)
    assert.strictEqual(pt.y, 220); // 200 + 40/2 - scroll(0)
  });

  // A CDP client for the occlusion probe folded into clickablePoint: getContentQuads
  // serves geometry, getNodeForLocation reports the topmost backendNodeId at a
  // point, describeNode returns a (pierced) subtree keyed by id. topmostAt(x,y)
  // lets a test vary the painted node by position — simulating a sibling that
  // covers only PART of the target's quad.
  function occlusionSession({ quads, layout, topmostAt, trees }) {
    return {
      client: {
        DOM: {
          enable: async () => {}, getDocument: async () => {}, scrollIntoViewIfNeeded: async () => {},
          getContentQuads: async () => ({ quads }),
          getNodeForLocation: async ({ x, y }) => ({ backendNodeId: topmostAt(x, y) }),
          describeNode: async ({ backendNodeId }) =>
            ({ node: trees[backendNodeId] || { backendNodeId, children: [] } }),
        },
        Page: { getLayoutMetrics: async () => layout },
      },
    };
  }
  // One 100×40 quad at (10,10): center (60,30); quincunx corners at x∈{35,85}, y∈{20,40}.
  const oneQuad = [10, 10, 110, 10, 110, 50, 10, 50];

  await test('clickablePoint returns the center when it hit-tests to the target', async () => {
    const session = occlusionSession({ quads: [oneQuad], layout: layout1k, topmostAt: () => 111, trees: {} });
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.strictEqual(pt.x, 60);
    assert.strictEqual(pt.y, 30);
  });

  await test('clickablePoint accepts a descendant of the target as the hit', async () => {
    const trees = { 111: { backendNodeId: 111, children: [{ backendNodeId: 999, children: [] }] } };
    const session = occlusionSession({ quads: [oneQuad], layout: layout1k, topmostAt: () => 999, trees });
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.strictEqual(pt.x, 60);   // 999 ∈ target subtree ⇒ center is accepted
    assert.strictEqual(pt.y, 30);
  });

  await test('clickablePoint skips a covered center and clicks a clear corner', async () => {
    // An overlay (222) paints over only the center; the rest of the quad is the target.
    const trees = { 111: { backendNodeId: 111, children: [] }, 222: { backendNodeId: 222, children: [] } };
    const topmostAt = (x, y) => (x === 60 && y === 30) ? 222 : 111;
    const session = occlusionSession({ quads: [oneQuad], layout: layout1k, topmostAt, trees });
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.ok(!(pt.x === 60 && pt.y === 30), 'must not return the covered center');
    assert.strictEqual(pt.x, 35);   // first quincunx corner that resolves to the target
    assert.strictEqual(pt.y, 20);
  });

  await test('clickablePoint throws "covered" only when every candidate is covered', async () => {
    const trees = {
      111: { backendNodeId: 111, children: [] },                 // target subtree: no 222
      222: { backendNodeId: 222, nodeName: 'DIV', attributes: ['id', 'cookie-wall'], children: [] },
    };
    const session = occlusionSession({ quads: [oneQuad], layout: layout1k, topmostAt: () => 222, trees });
    await assert.rejects(
      () => clickablePoint({ session, brief: makeBrief(), ref: '@e1' }),
      /covered .*cookie-wall/
    );
  });

  await test('clickablePoint fails open (best-quad center) when hit-testing is unavailable', async () => {
    // Geometry present but no getNodeForLocation ⇒ aim at the center, no "covered".
    const session = quadSession({ quads: [oneQuad], layout: layout1k });
    const pt = await clickablePoint({ session, brief: makeBrief(), ref: '@e1' });
    assert.strictEqual(pt.x, 60);
    assert.strictEqual(pt.y, 30);
  });

  await test('cdp type clears the field by default (select-all before insertText)', async () => {
    const session = makeFakeSession([makeBrief()]); // @e1 role 'textbox'
    const exec = createExecutor({ backend: 'cdp' }, {});
    await exec.execute([action('type', { ref: '@e1', args: { text: 'hi' } })], session, makeBrief());
    const selectAll = session.calls.find(c => c[0] === 'key' && c[1].type === 'keyDown' && c[1].key === 'a');
    assert.ok(selectAll, 'expected a select-all keyDown before typing');
    assert.ok(selectAll[1].modifiers === 2 || selectAll[1].modifiers === 4, 'select-all carries Ctrl/Meta');
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hi'));
  });

  await test('cdp type with clear:false appends (no select-all)', async () => {
    const session = makeFakeSession([makeBrief()]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    await exec.execute([action('type', { ref: '@e1', args: { text: 'hi', clear: false } })], session, makeBrief());
    assert.ok(!session.calls.some(c => c[0] === 'key' && c[1].key === 'a'), 'no select-all when clear:false');
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hi'));
  });

  await test('cdp type does not select-all a non-text element', async () => {
    const brief = makeBrief({ elements: [{ ref: '@e1', role: 'button', name: 'Go', bbox: [100, 200, 80, 30] }] });
    const session = makeFakeSession([brief]);
    const exec = createExecutor({ backend: 'cdp' }, {});
    await exec.execute([action('type', { ref: '@e1', args: { text: 'hi' } })], session, brief);
    assert.ok(!session.calls.some(c => c[0] === 'key' && c[1].key === 'a'), 'button role is not cleared');
  });
}

async function configSuite() {
  console.log('\nconfig:');

  await test('deepMerge preserves sibling defaults and skips undefined overrides', () => {
    const merged = deepMerge(DEFAULTS, {
      loop: { maxSteps: 7, pollMs: undefined },
      view: { maxTextChars: 80 },
    });
    assert.strictEqual(merged.loop.maxSteps, 7);
    assert.strictEqual(merged.loop.pollMs, DEFAULTS.loop.pollMs);
    assert.strictEqual(merged.loop.shortCircuitOnNoChange, DEFAULTS.loop.shortCircuitOnNoChange);
    assert.strictEqual(merged.view.maxTextChars, 80);
    assert.strictEqual(merged.executor.backend, DEFAULTS.executor.backend);
  });

  await test('env overrides do not mutate DEFAULTS across reloads', () => {
    const oldProvider = process.env.BROWSER_AGENT_PROVIDER;
    const oldExecutor = process.env.BROWSER_AGENT_EXECUTOR;
    try {
      process.env.BROWSER_AGENT_PROVIDER = 'anthropic';
      process.env.BROWSER_AGENT_EXECUTOR = 'cdp';
      const overridden = loadConfig({ path: path.join(os.tmpdir(), 'missing-browser-agent-config.json'), reload: true });
      assert.strictEqual(overridden.models.primary.provider, 'anthropic');
      assert.strictEqual(overridden.executor.backend, 'cdp');

      delete process.env.BROWSER_AGENT_PROVIDER;
      delete process.env.BROWSER_AGENT_EXECUTOR;
      const fresh = loadConfig({ path: path.join(os.tmpdir(), 'missing-browser-agent-config.json'), reload: true });
      assert.strictEqual(fresh.models.primary.provider, DEFAULTS.models.primary.provider);
      assert.strictEqual(fresh.executor.backend, DEFAULTS.executor.backend);
    } finally {
      if (oldProvider === undefined) delete process.env.BROWSER_AGENT_PROVIDER;
      else process.env.BROWSER_AGENT_PROVIDER = oldProvider;
      if (oldExecutor === undefined) delete process.env.BROWSER_AGENT_EXECUTOR;
      else process.env.BROWSER_AGENT_EXECUTOR = oldExecutor;
      loadConfig({ path: path.join(os.tmpdir(), 'missing-browser-agent-config.json'), reload: true });
    }
  });

  await test('invalid config JSON fails explicitly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-config-'));
    const file = path.join(dir, 'bad.json');
    try {
      fs.writeFileSync(file, '{ bad json');
      assert.throws(() => loadConfig({ path: file, reload: true }), ConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function withLaunchMocks({ pids = [], commands = {}, livePorts = [] }, fn) {
  const childProcess = require('child_process');
  const CDP = require('chrome-remote-interface');
  const launchPath = require.resolve('../lib/launch');
  const oldExecFileSync = childProcess.execFileSync;
  const oldList = CDP.List;
  delete require.cache[launchPath];

  childProcess.execFileSync = (cmd, args, opts) => {
    if (cmd === 'pgrep') {
      if (!pids.length) throw new Error('no process');
      return `${pids.join('\n')}\n`;
    }
    if (cmd === 'ps') {
      const pid = args[args.indexOf('-p') + 1];
      if (commands[pid]) return commands[pid];
      throw new Error(`unknown pid ${pid}`);
    }
    return oldExecFileSync(cmd, args, opts);
  };
  CDP.List = async ({ port }) => {
    if (livePorts.includes(Number(port))) return [];
    throw new Error(`no CDP on ${port}`);
  };

  try {
    return await fn(require('../lib/launch'));
  } finally {
    childProcess.execFileSync = oldExecFileSync;
    CDP.List = oldList;
    delete require.cache[launchPath];
  }
}

async function launchSuite() {
  console.log('\nlaunch:');

  await test('remoteDebuggingPortFromCommand parses Chrome command lines', () => {
    const { remoteDebuggingPortFromCommand } = require('../lib/launch');
    assert.strictEqual(remoteDebuggingPortFromCommand('chrome --remote-debugging-port=9223 --user-data-dir=/tmp/p'), 9223);
    assert.strictEqual(remoteDebuggingPortFromCommand('chrome --remote-debugging-port 9333'), 9333);
    assert.strictEqual(remoteDebuggingPortFromCommand('chrome --remote-debugging-port=0'), null);
    assert.strictEqual(remoteDebuggingPortFromCommand('chrome'), null);
  });

  await test('profile ownership is tied to the same debug port', async () => {
    if (process.platform === 'win32') return;
    await withLaunchMocks({
      pids: ['101', '102'],
      commands: {
        101: 'Google Chrome --user-data-dir=/tmp/browser-agent-profile --remote-debugging-port=9223',
        102: 'Google Chrome --type=renderer --user-data-dir=/tmp/browser-agent-profile --remote-debugging-port=9223',
      },
      livePorts: [9222, 9223],
    }, async ({ isOwnChrome, debugPortForProfile }) => {
      assert.strictEqual(await debugPortForProfile('/tmp/browser-agent-profile'), 9223);
      assert.strictEqual(await isOwnChrome(9223, '/tmp/browser-agent-profile'), true);
      assert.strictEqual(await isOwnChrome(9222, '/tmp/browser-agent-profile'), false);
    });
  });

  await test('launch reuses an existing browser-agent profile on a non-default port', async () => {
    if (process.platform === 'win32') return;
    await withLaunchMocks({
      pids: ['201'],
      commands: {
        201: 'Google Chrome --user-data-dir=/tmp/browser-agent-profile --remote-debugging-port=9224',
      },
      livePorts: [9224],
    }, async ({ launch }) => {
      assert.strictEqual(await launch({ port: 9222, userDataDir: '/tmp/browser-agent-profile' }), 9224);
    });
  });
}

async function scratchpadSuite() {
  console.log('\nscratchpad:');

  await test('disabled scratchpad performs no filesystem writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ enabled: false, dir, runId: 'x' });
      assert.strictEqual(scratch.saveText({ content: 'Nope' }), null);
      assert.strictEqual(scratch.saveImage({ base64: Buffer.from('x').toString('base64') }), null);
      assert.strictEqual(scratch.writeReport('report'), null);
      assert.strictEqual(scratch.readManifest(), '');
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saveText writes manifest entries and saveImage persists assets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const text = scratch.saveText({ content: 'Full captured text', summary: 'Captured note', url: 'https://example.test/a' });
      const image = scratch.saveImage({ base64: Buffer.from('png bytes').toString('base64'), title: 'Shot' });
      const manifest = JSON.parse(scratch.readManifest());

      assert.strictEqual(text.path, scratch.manifestPath);
      assert.strictEqual(fs.readFileSync(image.path, 'utf8'), 'png bytes');
      assert.strictEqual(manifest.version, 1);
      assert.strictEqual(manifest.asset_dir, 'assets');
      assert.deepStrictEqual(manifest.records, []);
      assert.strictEqual(manifest.unassigned.length, 2);
      assert.deepStrictEqual(manifest.unassigned[0], {
        kind: 'text',
        content: 'Full captured text',
        metadata: {
          url: 'https://example.test/a',
          summary: 'Captured note',
        },
      });
      assert.strictEqual(manifest.unassigned[1].kind, 'image');
      assert.strictEqual(manifest.unassigned[1].file_name, 'screenshot-1.png');
      assert.strictEqual(manifest.unassigned[1].metadata.title, 'Shot');
      assert.strictEqual(scratch.saveCount, 2);
      assert.strictEqual(scratch.textCount, 1);
      assert.strictEqual(scratch.imageCount, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saved text, images, and files include optional reason metadata', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      scratch.saveText({ content: 'Fact', summary: 'Fact saved', reason: 'preserve fact before navigating' });
      scratch.saveImage({ base64: Buffer.from('png').toString('base64'), reason: 'read chart labels' });
      scratch.saveAsset({ filename: 'report.pdf', base64: Buffer.from('pdf').toString('base64'), reason: 'keep source document' });
      const manifest = JSON.parse(scratch.readManifest());

      assert.deepStrictEqual(manifest.unassigned.map(s => s.save_reason), [
        'preserve fact before navigating',
        'read chart labels',
        'keep source document',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saveRecord groups current unassigned saves and leaves later saves unassigned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      scratch.saveImage({
        base64: Buffer.from('png').toString('base64'),
        description: 'A product screenshot',
        metadata: { ref: '@r1', role: 'image' },
      });
      scratch.saveAsset({
        filename: 'report.pdf',
        base64: Buffer.from('pdf').toString('base64'),
        summary: 'Source report',
        url: 'https://example.test/report.pdf',
      });
      scratch.saveRecord({
        metadata: '{"company":"Acme","role":"Head of Product"}',
        url: 'https://example.test/jobs/1',
        reason: 'complete Acme role',
      });
      scratch.saveText({ content: 'Global note', summary: 'Global note saved' });
      const manifest = JSON.parse(scratch.readManifest());

      assert.strictEqual(manifest.records.length, 1);
      assert.deepStrictEqual(manifest.records[0].metadata, {
        company: 'Acme',
        role: 'Head of Product',
        url: 'https://example.test/jobs/1',
        save_reason: 'complete Acme role',
      });
      assert.deepStrictEqual(manifest.records[0].saves.map(s => s.kind), ['image', 'file']);
      assert.strictEqual(manifest.records[0].saves[0].metadata.ref, '@r1');
      assert.strictEqual(manifest.records[0].saves[1].metadata.source_url, 'https://example.test/report.pdf');
      assert.deepStrictEqual(manifest.unassigned.map(s => s.kind), ['text']);
      assert.strictEqual(manifest.unassigned[0].content, 'Global note');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saveText cleans webpage text before storing manifest content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      scratch.saveText({
        content: '<h1>Title &amp; More</h1><p>Read <strong>this</strong> [link](https://example.test).</p>',
        summary: 'Captured page text',
      });

      const item = JSON.parse(scratch.readManifest()).unassigned[0];
      assert.strictEqual(item.content, 'Title & More\nRead this link.');
      assert.strictEqual(item.metadata.summary, 'Captured page text');
      assert.ok(!item.content.includes('<h1>'));
      assert.ok(!item.content.includes('https://example.test'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('html report linkifies URLs and adds overflow-safe CSS', () => {
    const url = `https://example.test/search?q=${'product+'.repeat(24)}role`;
    const html = markdownToHtml(`URL: ${url}]`);
    const doc = markdownToHtmlDocument(`URL: ${url}]`);
    assert.ok(html.includes(`href="${url}"`));
    assert.ok(html.includes('target="_blank"'));
    assert.ok(html.includes('</a>]'), 'trailing bracket stays outside link');
    assert.ok(doc.includes('overflow-wrap:anywhere'));
    assert.ok(doc.includes('word-break:break-word'));
  });

  await test('html report uses markdown library basics', () => {
    const html = markdownToHtml('> Store each one like this:\n> \n> ## [Company] — [Title]');
    assert.strictEqual((html.match(/<blockquote>/g) || []).length, 1);
    assert.ok(html.includes('<h2>[Company]'));
  });

  await test('html report document accepts layout and CSS options', () => {
    const plain = markdownToHtmlDocument('# Report', {
      layout: 'plain',
      className: 'handoff',
      extraCss: '.handoff{max-width:72ch}',
    });
    assert.ok(plain.includes('<main class="handoff">'));
    assert.ok(plain.includes('.handoff{max-width:72ch}'));
    assert.ok(!plain.includes('max-width:960px'), 'plain layout omits default report frame');
  });

  await test('filenameStemFromHint makes durable language slugs', () => {
    assert.strictEqual(filenameStemFromHint('Read the chart labels & values!'), 'read-the-chart-labels-and-values');
    assert.strictEqual(filenameStemFromHint('  Résumé / Q2 – totals  '), 'resume-q2-totals');
    assert.strictEqual(filenameStemFromHint('---'), null);
  });

  await test('hinted screenshots include slug and supplied id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const image = scratch.saveImage({
        base64: Buffer.from('jpg bytes').toString('base64'),
        hint: 'Read chart labels',
        id: 7,
        ext: 'jpg',
      });

      assert.strictEqual(image.name, 'read-chart-labels-screenshot-7.jpg');
      const item = JSON.parse(scratch.readManifest()).unassigned[0];
      assert.strictEqual(item.file_name, 'read-chart-labels-screenshot-7.jpg');
      assert.strictEqual(item.metadata.title, 'Read chart labels screenshot');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('scratchpad creates run dir and writes report', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const markdown = '# Report\n\nhttps://example.test/a?x=1&y=2';
      assert.ok(fs.existsSync(scratch.dir), 'run directory exists at init');
      assert.strictEqual(scratch.writeReport(markdown, { className: 'handoff', extraCss: '.handoff{max-width:72ch}' }), scratch.reportPath);
      assert.strictEqual(fs.readFileSync(scratch.reportPath, 'utf8'), markdown);
      const html = fs.readFileSync(scratch.reportHtmlPath, 'utf8');
      assert.ok(html.includes('<h1>Report</h1>'));
      assert.ok(html.includes('href="https://example.test/a?x=1&amp;y=2"'));
      assert.ok(html.includes('target="_blank"'));
      assert.ok(html.includes('rel="noopener noreferrer"'));
      assert.ok(html.includes('<main class="handoff">'));
      assert.ok(html.includes('.handoff{max-width:72ch}'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('saveAsset uses durable file slugs and suffixes collisions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const first = scratch.saveAsset({ filename: 'report.pdf', base64: Buffer.from('first').toString('base64'), summary: 'first' });
      const second = scratch.saveAsset({ filename: 'report.pdf', base64: Buffer.from('second').toString('base64'), summary: 'second' });

      assert.strictEqual(first.name, 'report-file-1.pdf');
      assert.strictEqual(second.name, 'report-file-2.pdf');
      assert.strictEqual(fs.readFileSync(first.path, 'utf8'), 'first');
      assert.strictEqual(fs.readFileSync(second.path, 'utf8'), 'second');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('hinted assets use screenshot-like naming with original extension and supplied id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-scratch-'));
    try {
      const scratch = createScratchpad({ dir, runId: 'run-1' });
      const file = scratch.saveAsset({
        filename: 'source report.pdf',
        base64: Buffer.from('pdf').toString('base64'),
        hint: 'Quarterly revenue report',
        id: 12,
      });

      assert.strictEqual(file.name, 'quarterly-revenue-report-file-12.pdf');
      const item = JSON.parse(scratch.readManifest()).unassigned[0];
      assert.strictEqual(item.kind, 'file');
      assert.strictEqual(item.file_name, 'quarterly-revenue-report-file-12.pdf');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function saveFileSuite() {
  console.log('\nsave_file:');
  const { saveFile } = require('../lib/savefile');

  await test('non-base64 data URIs are percent-decoded before saving', async () => {
    const out = await saveFile({ session: { client: {} }, brief: {}, url: 'data:text/plain,hello%20world%21' });
    assert.strictEqual(Buffer.from(out.fileBytes, 'base64').toString('utf8'), 'hello world!');
  });
}

async function logSuite() {
  console.log('\nlog:');

  await test('disabled logger is a no-op and creates no files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-log-'));
    const logDir = path.join(dir, 'logs');
    try {
      const logger = createLogger({ enabled: false, dir: logDir });
      logger.event({ kind: 'turn' });
      logger.finalize({ status: 'completed', result: null, stats: {} });
      assert.strictEqual(fs.existsSync(logDir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

async function agentCliSuite() {
  console.log('\nagent cli:');

  await test('buildHandoff returns the compact stdout contract with absolute paths', () => {
    const runArtifact = {
      id: 'run-1',
      task: 'Collect listings',
      status: 'completed',
      result: 'ok',
      report: '# Report',
      reportEvidence: { source: 'saved-manifest.json', rawTokens: 4500 },
      artifacts: {
        runDir: '/tmp/runs/run-1',
        reportPath: '/tmp/runs/run-1/report.md',
        reportHtmlPath: '/tmp/runs/run-1/report.html',
        savedManifestPath: '/tmp/runs/run-1/saved-manifest.json',
        assetsDir: '/tmp/runs/run-1/assets',
        logPath: '/tmp/logs/latest.json',
        jsonlPath: '/tmp/logs/latest.jsonl',
      },
      stats: {
        stepCount: 12,
        totalElapsedMs: 3456,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalEstimatedPromptTokens: 500,
      },
    };

    const out = buildHandoff(runArtifact, { context: '  prefer concise summaries  ' });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.status, 'completed');
    assert.strictEqual(out.runId, 'run-1');
    assert.strictEqual(out.context, 'prefer concise summaries');
    assert.strictEqual(out.report.markdown, '# Report');
    assert.strictEqual(out.report.path, '/tmp/runs/run-1/report.md');
    assert.strictEqual(out.report.htmlPath, '/tmp/runs/run-1/report.html');
    assert.strictEqual(out.report.evidenceSource, 'saved-manifest.json');
    assert.strictEqual(out.artifacts.savedManifest, '/tmp/runs/run-1/saved-manifest.json');
    assert.strictEqual(out.artifacts.assetsDir, '/tmp/runs/run-1/assets');
    assert.strictEqual(out.artifacts.log, '/tmp/logs/latest.json');
    assert.strictEqual(out.artifacts.jsonl, '/tmp/logs/latest.jsonl');
    assert.deepStrictEqual(out.stats, {
      steps: 12,
      elapsedMs: 3456,
      inputTokens: 100,
      outputTokens: 50,
      estimatedPromptTokens: 500,
    });
    assert.strictEqual(out.error, null);
  });
}

async function promptSuite() {
  console.log('\nprompt:');

  await test('system prompt renders action signatures from the registry', () => {
    const prompt = buildSystemPrompt({
      click: registry.click,
      type: registry.type,
      wait: registry.wait,
      take_screenshot: registry.take_screenshot,
      save_text: registry.save_text,
      save_image: registry.save_image,
      save_record: registry.save_record,
      done: registry.done,
    });
    assert.ok(prompt.includes('click[@e|@t]'), 'click ref types should be shown');
    assert.ok(prompt.includes('type[@e] (intent: string, text: string, clear: boolean?, submit: boolean?)'), 'required + optional args should be shown');
    assert.ok(prompt.includes('wait (intent: string, ms: number)'), 'wait args should be shown');
    assert.ok(prompt.includes('take_screenshot[@e|@t|@r] (ref: string?, intent: string, hint: string?)'), 'optional ref types should be shown');
    assert.ok(prompt.includes('save_image[@e|@t|@r|@v] (ref: string?, intent: string, hint: string?)'), 'visual image promotion should be shown');
    assert.ok(prompt.includes('save_record (intent: string, metadata: string?)'), 'record grouping action should be shown');
    assert.ok(prompt.includes('done (intent: string, result: string?)'), 'optional args should be marked');
    assert.ok(prompt.includes('describing where this'), 'intent rule should be explicit');
    assert.ok(prompt.includes('never pass punctuation, CSS selectors, words, or coordinates as ref'), 'screenshot refs should be hardened');
    assert.ok(prompt.includes('Do not save intermediate report drafts'), 'operating rules should discourage draft-saving');
    assert.ok(prompt.includes('Do not use save_text for intermediate answer drafts'), 'save_text should discourage drafts');
    assert.ok(prompt.includes('call save_record when one item/listing/application is'), 'record-style tasks should close records');
  });

  await test('image discovery tool is absent from registry and prompt', () => {
    assert.strictEqual(registry.get_images, undefined);
    assert.ok(!buildSystemPrompt(registry).includes('get_images'));
  });

  await test('context is omitted (no header) when null/empty', () => {
    const reg = { click: registry.click, done: registry.done };
    const base = buildSystemPrompt(reg);
    assert.ok(!base.includes('Context ('), 'no context header when absent');
    assert.strictEqual(buildSystemPrompt(reg, null), base, 'null → identical to no arg');
    assert.strictEqual(buildSystemPrompt(reg, '   '), base, 'whitespace-only → omitted');
  });

  await test('context, when present, is appended as a trusted block at the very end', () => {
    const reg = { click: registry.click, done: registry.done };
    const base = buildSystemPrompt(reg);
    const ctx = 'The user is Taylor; prefers concise replies.';
    const withCtx = buildSystemPrompt(reg, ctx);
    // The static template must remain an unmodified prefix, so providers can
    // cache it across runs regardless of the per-run context value.
    assert.ok(withCtx.startsWith(base), 'static template stays an intact prefix');
    assert.ok(withCtx.endsWith(ctx), 'context sits at the very end (nothing cacheable after it)');
    assert.ok(withCtx.includes('Context ('), 'trusted header is shown when present');
  });
}

async function tokenSuite() {
  console.log('\ntokens:');

  await test('estimateTokens approximates strings and message objects', () => {
    assert.strictEqual(estimateTokens(''), 0);
    assert.strictEqual(estimateTokens('abcd'), 1);
    assert.strictEqual(estimateTokens({ role: 'user', content: 'abcdefgh' }), 4);
  });
}

async function textSuite() {
  console.log('\ntext:');

  await test('decodeHtmlEntities handles named, numeric, and hex entities', () => {
    assert.strictEqual(
      decodeHtmlEntities('Tom &amp; Jerry &#169; &#x1F600; &UNKNOWN;'),
      'Tom & Jerry © 😀 &UNKNOWN;',
    );
  });

  await test('cleanWebText strips web markup and keeps readable content', () => {
    const input = `
      <style>.x{}</style><script>alert(1)</script>
      <h1>Title &amp; More</h1>
      <p>Hello&nbsp;<strong>world</strong>.</p>
      <ul><li>First</li><li><a href="/x">Second link</a></li></ul>
    `;

    assert.strictEqual(cleanWebText(input), 'Title & More\n\nHello world.\n\nFirst\nSecond link');
  });

  await test('cleanWebText flattens markdown into plain text', () => {
    assert.strictEqual(
      cleanWebText('# Heading\n\n- **One** [link](https://example.test)\n- `Two`\n\n> Quote'),
      'Heading\nOne link\nTwo\n\nQuote',
    );
  });
}

async function loopSuite() {
  console.log('\nloop:');

  await test('type → press → scroll → wait → done drives to completed', async () => {
    installFakeProvider([
      [action('type', { ref: '@e1', args: { text: 'hello' } })],
      [action('press', { args: { key: 'Enter' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('wait', { args: { ms: 1 } })],
      [action('done', { args: { result: 'searched' } })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief, makeBrief, makeBrief, makeBrief]);
    const r = await run({ session, task: 'search hello', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.result, 'searched');
    assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['type', 'press', 'scroll', 'wait', 'done']);
    assert.ok(session.calls.some(c => c[0] === 'insertText' && c[1].text === 'hello'));
    assert.ok(session.calls.some(c => c[0] === 'key' && c[1].key === 'Enter'));
    assert.ok(session.calls.some(c => c[0] === 'mouse' && c[1].type === 'mouseWheel'));
  });

  await test('an all-invalid turn feeds the error back and the run continues', async () => {
    installFakeProvider([
      [action('type', { ref: '@t1', args: { text: 'x' } })],  // invalid: type is @e-only
      [action('done', { args: { result: 'ok' } })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.steps.length, 1, 'only the done step executed');
    assert.strictEqual(r.steps[0].action.verb, 'done');
  });

  await test('no-change short-circuit polls until the page changes', async () => {
    installFakeProvider([
      [action('press', { args: { key: 'ArrowDown' } })],  // executes; page "unchanged"
      [action('done', { args: {} })],
    ]);
    const same1 = makeBrief();
    const same2 = makeBrief();                          // identical content ⇒ same hash
    const changed = makeBrief({ title: 'Changed' });    // different hash
    const session = makeFakeSession([same1, same2, changed]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 5 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    // turn1: 1 extract; turn2: 1 (same) + 1 (poll→changed) = 2 ⇒ 3 total
    assert.strictEqual(session.extractCount, 3);
  });

  await test('sparse post-navigation brief is retried before prompting', async () => {
    const reqs = installFakeProvider([
      [action('click', { ref: '@e1' })],
      [action('done', { args: {} })],
    ]);
    const sparse = makeBrief({ url: 'http://example.test/b', title: 'Loading', elements: [], text: [], regions: [], lookup: {} });
    const loaded = makeBrief({ url: 'http://example.test/b', title: 'Loaded' });
    const session = makeFakeSession([
      makeBrief({ url: 'http://example.test/a' }),
      sparse,
      loaded,
    ]);
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({ loop: { maxSparsePageRetries: 2, sparsePageRetryMs: 0, sparsePageMinNodes: 2 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.match(reqs[1].messages[0].content, /Title: Loaded/);
    assert.ok(!reqs[1].messages[0].content.includes('(no interactive elements)'), 'loaded listing should be used');
    assert.strictEqual(session.extractCount, 3);
  });

  await test('max-steps is honored', async () => {
    installFakeProvider([[action('press', { args: { key: 'ArrowDown' } })]]);  // never finishes
    const session = makeFakeSession([makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig({ loop: { maxSteps: 3 } }) });
    assert.strictEqual(r.status, 'max-steps');
    assert.strictEqual(r.steps.length, 3);
  });

  await test('empty-plan guard aborts after consecutive no-action turns', async () => {
    installFakeProvider([[], [], [], [action('done', { args: {} })]]);
    const session = makeFakeSession([makeBrief, makeBrief, makeBrief, makeBrief]);
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({ loop: { maxEmptyPlans: 3 } }),
    });
    assert.strictEqual(r.status, 'empty-plan');
    assert.match(r.result, /no actions for 3 consecutive turns/);
    assert.strictEqual(r.steps.length, 0);
  });

  await test('loop executes only the first planned action per turn', async () => {
    const reqs = installFakeProvider([
      [
        action('click', { ref: '@e1', args: { intent: 'open result' } }),
        action('press', { args: { key: 'Enter', intent: 'stale second action' } }),
      ],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['click', 'done']);
    assert.match(reqs[1].messages[0].content, /pressed Enter — intent: stale second action — rejected: ignored: only one action per turn is allowed/);
  });

  await test('no-op guard aborts when the model repeats a dead action', async () => {
    installFakeProvider([[action('click', { ref: '@e1' })]]);  // same click forever
    const session = makeFakeSession([makeBrief]);              // page never changes ⇒ no-op
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 } }),
    });
    assert.strictEqual(r.status, 'stuck', r.error);
    // click executes twice; the 3rd identical pick (with no page change) aborts.
    assert.strictEqual(r.steps.length, 2);
  });

  await test('intent metadata does not bypass repeated-action guard', async () => {
    installFakeProvider([
      [action('click', { ref: '@e1', args: { intent: 'try search' } })],
      [action('click', { ref: '@e1', args: { intent: 'retry search differently' } })],
      [action('click', { ref: '@e1', args: { intent: 'still test same click' } })],
    ]);
    const session = makeFakeSession([makeBrief]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 } }),
    });
    assert.strictEqual(r.status, 'stuck', r.error);
    assert.strictEqual(r.steps.length, 2);
  });

  await test('repeated scroll direction adds a pivot warning despite varied intents', async () => {
    const reqs = installFakeProvider([
      [action('scroll', { args: { direction: 'down', intent: 'inspect more evidence' } })],
      [action('scroll', { args: { direction: 'down', intent: 'find lower careers link' } })],
      [action('scroll', { args: { direction: 'down', intent: 'reveal footer links' } })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, contentHeight: 3000 } }),
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 600, contentHeight: 3000 } }),
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 1200, contentHeight: 3000 } }),
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 1800, contentHeight: 3000 } }),
    ]);
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({ loop: { maxSameDirectionScrolls: 3 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.match(reqs[3].messages[0].content, /scrolled down 3x on this page without finding the target/);
    assert.match(reqs[3].messages[0].content, /save what's useful, go back, or finish/);
  });

  await test('monotonic scrolling never triggers a reflection turn', async () => {
    // Long-page reading (all down) earns only the soft warning — it must NOT
    // escalate to a reflection turn, no matter how many scrolls.
    installFakeProvider([
      [action('scroll', { args: { direction: 'down' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('scroll', { args: { direction: 'down' } })],
      [action('done', { args: {} })],
    ]);
    let sy = 0;
    const briefs = Array.from({ length: 6 }, () =>
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: (sy += 600), contentHeight: 9000 } }));
    const session = makeFakeSession(briefs);
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({ loop: { maxScrollReversals: 3, maxSameDirectionScrolls: 3 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.ok(!r.completions.some(c => /reflection|scroll-oscillation/.test(JSON.stringify(c))),
      'monotonic scrolling must not fire a reflection');
  });

  await test('scroll oscillation (down↔up) fires a reflection turn', async () => {
    const reqs = installFakeProvider(
      [
        [action('scroll', { args: { direction: 'down' } })],
        [action('scroll', { args: { direction: 'up' } })],   // reversal 1
        [action('scroll', { args: { direction: 'down' } })], // reversal 2
        [action('scroll', { args: { direction: 'up' } })],   // reversal 3 → escalate
        [action('done', { args: {} })],                       // pivot after the reflection
      ],
      ['Pivot: save the section then go back to search'],     // the reflection decision
    );
    // Oscillating scrollY so the page "changes" each turn, proving escalation
    // keys on direction reversals, not on a frozen page.
    const ys = [600, 0, 600, 0, 600];
    const session = makeFakeSession(ys.map(y =>
      makeBrief({ viewport: { width: 1000, height: 800, scrollX: 0, scrollY: y, contentHeight: 3000 } })));
    const r = await run({
      session,
      task: 'x',
      config: baseConfig({
        loop: { maxScrollReversals: 3 },
        reflect: { enabled: true, maxReflections: 5, cooldownTurns: 0 },
      }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    const reflectCalls = reqs.filter(q => !q.tools || q.tools.length === 0);
    assert.strictEqual(reflectCalls.length, 1, 'exactly one reflection (no-tools) turn fired from the oscillation');
    // The reflection prompt names the thrashing explicitly so the model pivots.
    assert.match(reflectCalls[0].messages[0].content, /scrolled back and forth on this page/);
    const reflectCompletion = r.completions.find(c => Array.isArray(c.actions) && c.actions.length === 0 && c.text);
    assert.ok(reflectCompletion, 'the reflection decision is recorded as a completion');
  });

  await test('screenshot repeated-read guard is crop-ref aware', async () => {
    const visionMod = require('../lib/vision');
    const origDescribe = visionMod.describe;
    visionMod.describe = async () => ({ summary: 'short', description: 'full' });
    const mkBrief = () => makeBrief({
      regions: [
        { ref: '@r1', role: 'image', bbox: { x: 0, y: 0, width: 10, height: 10 } },
        { ref: '@r2', role: 'image', bbox: { x: 20, y: 0, width: 10, height: 10 } },
        { ref: '@r3', role: 'image', bbox: { x: 40, y: 0, width: 10, height: 10 } },
      ],
      lookup: { '@e1': 111, '@t1': 222, '@r1': 1, '@r2': 2, '@r3': 3 },
    });
    const runRefs = async (refs) => {
      installFakeProvider([...refs.map(ref => [action('take_screenshot', { ref })]), [action('done', { args: {} })]]);
      const session = makeFakeSession([mkBrief]);
      session.client.Page = { captureScreenshot: async () => ({ data: Buffer.from('png').toString('base64') }) };
      return run({ session, task: 'inspect crops', config: baseConfig({ loop: { maxSteps: 5, maxStuckRepeats: 2 }, scratchpad: { enabled: false } }) });
    };
    try {
      const distinct = await runRefs(['@r1', '@r2', '@r3']);
      assert.strictEqual(distinct.status, 'completed', distinct.error);
      assert.deepStrictEqual(distinct.steps.slice(0, 3).map(s => s.action.ref), ['@r1', '@r2', '@r3']);

      const repeated = await runRefs(['@r1', '@r1', '@r1']);
      assert.strictEqual(repeated.status, 'stuck', repeated.error);
      assert.deepStrictEqual(repeated.steps.map(s => s.action.ref), ['@r1', '@r1']);
    } finally {
      visionMod.describe = origDescribe;
    }
  });

  await test('error-repeat guard aborts when a re-issued action keeps erroring', async () => {
    installFakeProvider([[action('click', { ref: '@e1' })]]);  // same click every turn
    const session = makeFakeSession([makeBrief]);              // brief stable across turns
    // The click ERRORS every turn (e.g. target covered by a sticky overlay). An
    // errored action nulls lastHash, so the no-op guard's `sameAction` can never
    // see it — the separate error-repeat guard (sameErroredTarget) must catch it.
    session.client.Input.dispatchMouseEvent = async (p) => {
      if (p.type === 'mousePressed') throw new Error('covered by sticky nav');
      session.calls.push(['mouse', p]);
    };
    const r = await run({ session, task: 'x', config: baseConfig({ loop: { maxStuckRepeats: 2 } }) });
    assert.strictEqual(r.status, 'stuck', r.error);
    // Errors on turns 1 and 2; the 3rd identical pick aborts before executing again.
    assert.strictEqual(r.steps.length, 2);
    assert.ok(r.steps.every(s => s.observation.status === 'error'), 'each recorded click errored');
  });

  await test('error-repeat guard resets when the model varies its action between errors', async () => {
    installFakeProvider([
      [action('click', { ref: '@e1' })],                    // errors
      [action('scroll', { args: { direction: 'down' } })],  // succeeds — model tries something else
      [action('click', { ref: '@e1' })],                    // errors again, but the streak reset
      [action('scroll', { args: { direction: 'down' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const session = makeFakeSession([makeBrief]);
    // Only the click (mousePressed) errors; the scroll's mouseWheel succeeds, so an
    // intervening different action breaks the error streak and we must NOT abort.
    session.client.Input.dispatchMouseEvent = async (p) => {
      if (p.type === 'mousePressed') throw new Error('covered by sticky nav');
      session.calls.push(['mouse', p]);
    };
    const r = await run({ session, task: 'x', config: baseConfig({ loop: { maxStuckRepeats: 2 } }) });
    assert.strictEqual(r.status, 'completed', r.error);
  });

  await test('repeated REJECTED action (invalid ref) aborts as stuck, not max-steps', async () => {
    // The model emits the same invalid action every turn (@e9 ∉ the snapshot's
    // lookup). It validates to nothing — no observation, no step — so the only
    // thing that can stop it is the stuck guard. Before the fix this ground all
    // the way to max-steps; now the rejected primary is tracked as an errored
    // target and sameErroredTarget aborts it.
    installFakeProvider([[action('click', { ref: '@e9' })]]);
    const session = makeFakeSession([makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig({ loop: { maxSteps: 20, maxStuckRepeats: 2 } }) });
    assert.strictEqual(r.status, 'stuck', r.error);
    assert.ok(r.stats.stepCount < 20, 'aborted well before max-steps');
  });

  await test('select_text reports the selected text and skips the no-change wait', async () => {
    const reqs = installFakeProvider([
      [action('select_text', { ref: '@t1' })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 5 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    // The next turn's prompt must show what got selected.
    assert.match(reqs[1].messages[0].content, /selected: "Welcome"/);
    // changesPage:false ⇒ no polling for a change that never comes: exactly one
    // extract per turn (2), not 2 + the maxNoChangePolls extras.
    assert.strictEqual(session.extractCount, 2);
  });

  await test('vision details stay out of the next prompt history', async () => {
    const visionMod = require('../lib/vision');
    const origDescribe = visionMod.describe;
    const full = 'FULL_DETAIL '.repeat(80).trim();
    visionMod.describe = async () => ({ summary: 'short chart summary', description: full });
    try {
      const reqs = installFakeProvider([
        [action('take_screenshot')],
        [action('done', { args: {} })],
      ]);
      const session = makeFakeSession([makeBrief, makeBrief]);
      session.client.Page = { captureScreenshot: async () => ({ data: Buffer.from('png').toString('base64') }) };
      const r = await run({ session, task: 'inspect image', config: baseConfig({ scratchpad: { enabled: false } }) });
      assert.strictEqual(r.status, 'completed', r.error);
      const t2 = reqs[1].messages[0].content;
      assert.ok(t2.includes('short chart summary'), 'summary re-enters prompt history');
      assert.ok(!t2.includes(full), 'full description stays out of prompt history');
    } finally {
      visionMod.describe = origDescribe;
    }
  });

  await test('take_screenshot reads pixels without persisting report assets', async () => {
    const visionMod = require('../lib/vision');
    const origDescribe = visionMod.describe;
    visionMod.describe = async () => ({ summary: 'visible page summary', description: 'visible page detail' });
    installFakeProvider([
      [action('take_screenshot')],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const session = makeFakeSession([makeBrief, makeBrief]);
      session.client.Page = { captureScreenshot: async () => ({ data: Buffer.from('read only').toString('base64') }) };
      const r = await run({
        session,
        task: 'inspect the screen',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      assert.strictEqual(r.status, 'completed', r.error);
      assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['take_screenshot', 'done']);
      assert.strictEqual(r.steps[0].observation.detail.savedPath, undefined);
      assert.ok(!fs.existsSync(r.artifacts.assetsDir), 'assets dir is not created by take_screenshot');
    } finally {
      visionMod.describe = origDescribe;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('turn message carries URL (fragment stripped), title, and scroll position', async () => {
    const reqs = installFakeProvider([[action('done', { args: {} })]]);
    const brief = makeBrief({
      url: 'http://example.test/feed#tracking=abc123',
      title: 'My Feed',
      viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 400, contentHeight: 2400 },
    });
    await run({ session: makeFakeSession([brief]), task: 'x', config: baseConfig() });
    const msg = reqs[0].messages[0].content;
    assert.ok(msg.includes('URL: http://example.test/feed'), 'url present');
    assert.ok(!msg.includes('tracking=abc123'), 'fragment stripped');
    assert.ok(msg.includes('Title: My Feed'), 'title present');
    assert.match(msg, /scrolled 400\/2400px/, 'scroll position present');
  });

  await test('turn message cleans tracking/noisy URL params for prompt display', async () => {
    const reqs = installFakeProvider([[action('done', { args: {} })]]);
    const brief = makeBrief({
      url: `https://www.google.com/search?q=funded+ai+startups&utm_source=newsletter&gs_lcrp=${'x'.repeat(800)}&sourceid=chrome#frag`,
    });
    const r = await run({ session: makeFakeSession([brief]), task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const msg = reqs[0].messages[0].content;
    assert.match(msg, /q=funded\+ai\+startups/);
    assert.ok(!msg.includes('utm_source'), 'tracking param should be dropped');
    assert.ok(!msg.includes('gs_lcrp'), 'google boilerplate param should be dropped');
    assert.ok(!msg.includes('#frag'), 'fragment should be dropped');
  });

  await test('completed no-save run still writes report.md', async () => {
    installFakeProvider([[action('done', { args: { result: 'ok' } })]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief]),
        task: 'finish',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      const reportPath = path.join(dir, r.id, 'report.md');
      const htmlPath = path.join(dir, r.id, 'report.html');
      assert.strictEqual(r.status, 'completed', r.error);
      assert.ok(fs.existsSync(reportPath), 'report.md exists even with no saves');
      assert.ok(fs.existsSync(htmlPath), 'report.html exists even with no saves');
      assert.ok(fs.readFileSync(reportPath, 'utf8').includes('## Saved Evidence (saved-manifest.json)\n\n_(nothing saved)_'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('final report synthesis writes model-organized report.md', async () => {
    const reqs = installFakeProvider([
      [action('save_text', { args: { content: 'Alpha finding', summary: 'Alpha saved' } })],
      [action('done', { args: { result: 'ok' } })],
    ], ['# Final Report\n\n- Organized Alpha finding']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief]),
        task: 'organize findings',
        config: {
          ...baseConfig({
            context: 'Prefer concise user-facing reports.',
            report: { enabled: true, provider: 'fake', model: 'report-model' },
          }),
          scratchpad: { enabled: true, dir },
        },
      });
      const report = fs.readFileSync(path.join(dir, r.id, 'report.md'), 'utf8');

      assert.strictEqual(r.status, 'completed', r.error);
      assert.strictEqual(report, '# Final Report\n\n- Organized Alpha finding');
      assert.ok(r.completions.some(c => c.model === 'fake-1'), 'report completion is recorded');
      assert.ok(reqs[2].messages[0].content.includes('Evidence source: saved-manifest.json'));
      assert.ok(reqs[2].system.includes('Think deeply about the best layout'));
      assert.ok(reqs[2].system.includes('Use both groups'));
      assert.ok(reqs[2].system.includes('descriptive Markdown links'));
      assert.ok(reqs[2].messages[0].content.includes('Trusted context:\nPrefer concise user-facing reports.'));
      assert.ok(reqs[2].messages[0].content.includes('Alpha finding'));
      assert.ok(reqs[2].messages[0].content.includes('"summary":"Alpha saved"'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('final report synthesis always uses saved-manifest.json evidence', async () => {
    const raw = 'RAW DETAIL '.repeat(200).trim();
    const reqs = installFakeProvider([
      [action('save_text', { args: { content: raw, summary: 'Alpha indexed finding' } })],
      [action('done', { args: { result: 'ok' } })],
    ], ['# Manifest Report\n\n- Alpha']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief]),
        task: 'summarize large search',
        config: { ...baseConfig({ report: { enabled: true, provider: 'fake', model: 'report-model' } }), scratchpad: { enabled: true, dir } },
      });
      const report = fs.readFileSync(path.join(dir, r.id, 'report.md'), 'utf8');
      const reportPrompt = reqs[2].messages[0].content;

      assert.strictEqual(r.status, 'completed', r.error);
      assert.strictEqual(report, '# Manifest Report\n\n- Alpha');
      assert.strictEqual(r.reportEvidence.source, 'saved-manifest.json');
      assert.ok(fs.existsSync(path.join(dir, r.id, 'saved-manifest.json')), 'saved-manifest.json exists');
      assert.ok(!fs.existsSync(path.join(dir, r.id, 'saved-index.md')), 'saved-index.md is not created');
      assert.ok(reportPrompt.includes('Evidence source: saved-manifest.json'));
      assert.ok(reportPrompt.includes('Evidence mode: manifest'));
      assert.ok(reportPrompt.includes('Alpha indexed finding'));
      assert.ok(reportPrompt.includes('RAW DETAIL'), 'manifest carries saved text content');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('save_image promotes cached visual evidence into the manifest', async () => {
    const visionMod = require('../lib/vision');
    const { clearVisualEvidenceCache } = require('../lib/visual_enrichment');
    const origClassify = visionMod.classifyVisualEvidence;
    const base64 = Buffer.from('cat image bytes').toString('base64');
    clearVisualEvidenceCache();
    visionMod.classifyVisualEvidence = async () => ({ kind: 'visual', description: 'Photo of a black cat', text: '' });
    installFakeProvider([
      [action('save_image', { ref: '@v1', args: { hint: 'cat photo' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const session = makeFakeSession([makeBrief({
        elements: [],
        text: [],
        regions: [{ ref: '@r1', role: 'image', bbox: { x: 0, y: 0, width: 100, height: 100 }, inViewport: true }],
        lookup: { '@r1': 11 },
      })]);
      session.client.Page = { captureScreenshot: async () => ({ data: base64 }) };
      const r = await run({
        session,
        task: 'save cat image',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      assert.strictEqual(r.status, 'completed', r.error);
      assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['save_image', 'done']);
      const manifest = JSON.parse(fs.readFileSync(r.artifacts.savedManifestPath, 'utf8'));
      assert.strictEqual(manifest.unassigned.length, 1);
      assert.strictEqual(manifest.unassigned[0].kind, 'image');
      assert.strictEqual(manifest.unassigned[0].save_reason, 'test intent');
      assert.strictEqual(manifest.unassigned[0].metadata.description, 'Photo of a black cat');
      assert.strictEqual(manifest.unassigned[0].metadata.ref, '@v1');
      const savedPath = path.join(r.artifacts.assetsDir, manifest.unassigned[0].file_name);
      assert.strictEqual(fs.readFileSync(savedPath).toString('utf8'), 'cat image bytes');
    } finally {
      visionMod.classifyVisualEvidence = origClassify;
      clearVisualEvidenceCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('save_image prefers original bytes for URL-backed visual evidence', async () => {
    const visionMod = require('../lib/vision');
    const { clearVisualEvidenceCache } = require('../lib/visual_enrichment');
    const origClassify = visionMod.classifyVisualEvidence;
    const cropBase64 = Buffer.from('cropped cat bytes').toString('base64');
    const originalBase64 = Buffer.from('original cat bytes').toString('base64');
    clearVisualEvidenceCache();
    visionMod.classifyVisualEvidence = async () => ({ kind: 'visual', description: 'Profile photo of a black cat', text: '' });
    installFakeProvider([
      [action('save_image', { ref: '@v1', args: { hint: 'cat profile' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const region = setHiddenSourceUrl(
        { ref: '@r1', role: 'image', bbox: { x: 0, y: 0, width: 100, height: 100 }, inViewport: true },
        'https://cdn.test/profile.jpg',
      );
      const session = makeFakeSession([makeBrief({
        elements: [],
        text: [],
        regions: [region],
        lookup: { '@r1': 11 },
      })]);
      session.client.Page = {
        captureScreenshot: async () => ({ data: cropBase64 }),
        getFrameTree: async () => ({ frameTree: { frame: { id: 'frame-1' } } }),
        getResourceContent: async ({ frameId, url }) => {
          assert.strictEqual(frameId, 'frame-1');
          assert.strictEqual(url, 'https://cdn.test/profile.jpg');
          return { content: originalBase64, base64Encoded: true };
        },
      };
      const r = await run({
        session,
        task: 'save cat profile image',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      assert.strictEqual(r.status, 'completed', r.error);
      const manifest = JSON.parse(fs.readFileSync(r.artifacts.savedManifestPath, 'utf8'));
      const saved = manifest.unassigned[0];
      assert.strictEqual(saved.kind, 'image');
      assert.strictEqual(saved.metadata.description, 'Profile photo of a black cat');
      assert.strictEqual(saved.metadata.source_url, 'https://cdn.test/profile.jpg');
      const savedPath = path.join(r.artifacts.assetsDir, saved.file_name);
      assert.strictEqual(fs.readFileSync(savedPath).toString('utf8'), 'original cat bytes');
    } finally {
      visionMod.classifyVisualEvidence = origClassify;
      clearVisualEvidenceCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('save_record groups saved evidence during a run', async () => {
    installFakeProvider([
      [action('save_text', { args: { content: 'Acme role detail', summary: 'Acme role saved' } })],
      [action('save_record', { args: { metadata: '{"company":"Acme","title":"Head of Product"}', intent: 'complete Acme record' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief, makeBrief]),
        task: 'save one record',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, r.id, 'saved-manifest.json'), 'utf8'));

      assert.strictEqual(r.status, 'completed', r.error);
      assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['save_text', 'save_record', 'done']);
      assert.strictEqual(manifest.records.length, 1);
      assert.deepStrictEqual(manifest.records[0].metadata.company, 'Acme');
      assert.strictEqual(manifest.records[0].metadata.save_reason, 'complete Acme record');
      assert.strictEqual(manifest.records[0].saves[0].content, 'Acme role detail');
      assert.deepStrictEqual(manifest.unassigned, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('done is held once when record-mode leaves unassigned saves', async () => {
    const reqs = installFakeProvider([
      [action('save_text', { args: { content: 'First record detail', summary: 'First saved' } })],
      [action('save_record', { args: { metadata: '{"rank":1}', intent: 'close first record' } })],
      [action('save_text', { args: { content: 'Second record detail', summary: 'Second saved' } })],
      [action('done', { args: { result: 'premature done', intent: 'finish early' } })],
      [action('save_record', { args: { metadata: '{"rank":2}', intent: 'close second record' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief, makeBrief, makeBrief, makeBrief, makeBrief]),
        task: 'save two records',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, r.id, 'saved-manifest.json'), 'utf8'));
      const afterRejectedDone = reqs[4].messages[0].content;

      assert.strictEqual(r.status, 'completed', r.error);
      assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['save_text', 'save_record', 'save_text', 'save_record', 'done']);
      assert.match(afterRejectedDone, /unassigned saved evidence exists \(1 item\) after 1 saved record/);
      assert.strictEqual(manifest.records.length, 2);
      assert.strictEqual(manifest.records[1].saves[0].content, 'Second record detail');
      assert.deepStrictEqual(manifest.unassigned, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('fallback report includes saved-manifest.json content only', async () => {
    installFakeProvider([
      [action('save_text', { args: { content: 'Full captured finding', summary: 'Captured finding' } })],
      [action('done', { args: { result: 'ok' } })],
    ]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-run-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief]),
        task: 'finish with saved content',
        config: { ...baseConfig(), scratchpad: { enabled: true, dir } },
      });
      const runDir = path.join(dir, r.id);
      const reportPath = path.join(runDir, 'report.md');
      const manifestPath = path.join(runDir, 'saved-manifest.json');
      const report = fs.readFileSync(reportPath, 'utf8');

      assert.strictEqual(r.status, 'completed', r.error);
      assert.ok(report.includes('Full captured finding'), 'report includes manifest content');
      assert.ok(report.includes('Final report synthesis disabled'), 'report records fallback reason');
      assert.ok(fs.existsSync(manifestPath), 'saved-manifest.json remains after final report is written');
      assert.ok(!fs.existsSync(path.join(runDir, 'saved.md')), 'saved.md is not created');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('a revisited URL is flagged in the turn message; a first visit is not', async () => {
    const reqs = installFakeProvider([
      [action('scroll', { args: { direction: 'down' } })],  // turn 1 @ /a
      [action('scroll', { args: { direction: 'down' } })],  // turn 2 @ /b
      [action('done', { args: {} })],                       // turn 3 @ /a (revisit)
    ]);
    const mk = (url) => () => makeBrief({ url });
    const session = makeFakeSession([mk('http://x.test/a'), mk('http://x.test/b'), mk('http://x.test/a')]);
    await run({ session, task: 'x', config: baseConfig({ loop: { shortCircuitOnNoChange: false } }) });
    assert.ok(!/REVISIT/.test(reqs[0].messages[0].content), 'first visit to /a is not flagged');
    assert.match(reqs[2].messages[0].content, /REVISIT — you've already been here 1×/, 'revisit to /a is flagged');
  });

  await test('arriving at the same page too many times fires a reflection turn', async () => {
    const reqs = installFakeProvider(
      [
        [action('scroll', { args: { direction: 'down' } })],  // turn 1 @ /a (visit 1)
        [action('scroll', { args: { direction: 'down' } })],  // turn 2 @ /b
        // turn 3 arrives @ /a (visit 2) → reflect fires before any action is planned
        [action('done', { args: {} })],                       // post-pivot turn @ /a
      ],
      ['Pivot: search a different source instead of reopening /a'],
    );
    const mk = (url) => () => makeBrief({ url });
    const session = makeFakeSession([
      mk('http://x.test/a'), mk('http://x.test/b'), mk('http://x.test/a'), mk('http://x.test/a'),
    ]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({
        loop: { shortCircuitOnNoChange: false, maxUrlVisits: 2 },
        reflect: { enabled: true, maxReflections: 5, cooldownTurns: 0, budgetTurnFraction: 0.99 },
      }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    const reflectCalls = reqs.filter(q => !q.tools || q.tools.length === 0);
    assert.strictEqual(reflectCalls.length, 1, 'the 2nd arrival at /a fires exactly one reflection');
    assert.match(reflectCalls[0].messages[0].content, /arrived on this page 2 times/);
  });

  await test('repeating an action does NOT abort when the page keeps changing', async () => {
    installFakeProvider([
      [action('click', { ref: '@e1' })],
      [action('click', { ref: '@e1' })],
      [action('done', { args: {} })],
    ]);
    // Distinct hashes each turn ⇒ changed=true ⇒ streak never builds.
    const session = makeFakeSession([
      () => makeBrief({ title: 'A' }),
      () => makeBrief({ title: 'B' }),
      () => makeBrief({ title: 'C' }),
    ]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({ loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
  });
}

async function reflectSuite() {
  console.log('\nreflection:');

  await test('a stuck run reflects and is rescued instead of aborting', async () => {
    const reqs = installFakeProvider(
      [
        [action('click', { ref: '@e1' })],   // turns 1-3: the same dead click
        [action('click', { ref: '@e1' })],
        [action('click', { ref: '@e1' })],
        [action('scroll', { args: { direction: 'down' } })],  // the pivot after reflection
        [action('done', { args: { result: 'ok' } })],
      ],
      ['Pivot: scroll down to reveal the results list'],         // the reflection decision
    );
    const session = makeFakeSession([makeBrief]);                // stable brief ⇒ no page change
    const r = await run({
      session, task: 'x',
      config: baseConfig({
        loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 },
        // budgetTurnFraction high so only the stuck trigger fires in this window.
        reflect: { enabled: true, maxReflections: 10, cooldownTurns: 4, budgetTurnFraction: 0.99 },
      }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    const reflectCalls = reqs.filter(q => !q.tools || q.tools.length === 0);
    assert.strictEqual(reflectCalls.length, 1, 'exactly one reflection (no-tools) turn fired');
    const reflectCompletion = r.completions.find(c => Array.isArray(c.actions) && c.actions.length === 0 && c.text);
    assert.ok(reflectCompletion, 'the reflection decision is recorded as a completion');
    assert.match(reflectCompletion.text, /scroll down/i);
    // The pivot ran and the run finished — the dead click did not abort it.
    assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['click', 'click', 'scroll', 'done']);
    // The decision is handed to the NEXT turn as a highlighted directive (not
    // just buried in History), and shown exactly once — the turn after it must
    // not still carry the directive.
    const tooled = reqs.filter(q => q.tools && q.tools.length);
    const withDirective = tooled.filter(q =>
      /⮕ REFLECT/.test(JSON.stringify(q.messages)) &&
      /scroll down to reveal the results list/.test(JSON.stringify(q.messages)));
    assert.strictEqual(withDirective.length, 1, 'pivot directive is shown on exactly one turn');
  });

  await test('reflection is capped: maxReflections 0 still aborts as stuck', async () => {
    const reqs = installFakeProvider([[action('click', { ref: '@e1' })]], ['Pivot somewhere new']);
    const session = makeFakeSession([makeBrief]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({
        loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 },
        reflect: { enabled: true, maxReflections: 0 },
      }),
    });
    assert.strictEqual(r.status, 'stuck', r.error);
    const reflectCalls = reqs.filter(q => !q.tools || q.tools.length === 0);
    assert.strictEqual(reflectCalls.length, 0, 'cap of 0 makes no reflection call');
  });

  await test('budget trigger fires once and does not consume the action queue', async () => {
    const reqs = installFakeProvider(
      [
        [action('click', { ref: '@e1' })],
        [action('scroll', { args: { direction: 'down' } })],
        [action('click', { ref: '@t1' })],
        [action('done', { args: { result: 'ok' } })],
      ],
      ['Staying the course — close to the answer'],
    );
    // Distinct briefs each turn ⇒ changed=true ⇒ no stuck streak; only budget fires.
    const session = makeFakeSession([
      () => makeBrief({ title: 'A' }),
      () => makeBrief({ title: 'B' }),
      () => makeBrief({ title: 'C' }),
      () => makeBrief({ title: 'D' }),
      () => makeBrief({ title: 'E' }),
    ]);
    const r = await run({
      session, task: 'x',
      config: baseConfig({
        loop: { maxSteps: 5, shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 },
        reflect: { enabled: true, maxReflections: 10, cooldownTurns: 4, budgetTurnFraction: 0.6 },
      }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    const reflectCalls = reqs.filter(q => !q.tools || q.tools.length === 0);
    assert.strictEqual(reflectCalls.length, 1, 'exactly one budget reflection');
    // All three planned actions ran in order — reflection did not steal a queue slot.
    assert.deepStrictEqual(r.steps.map(s => s.action.verb), ['click', 'scroll', 'click', 'done']);
  });

  await test('reflection turn uses its configured model, distinct from the planner', async () => {
    const reqs = installFakeProvider(
      [
        [action('click', { ref: '@e1' })],
        [action('click', { ref: '@e1' })],
        [action('click', { ref: '@e1' })],
        [action('done', { args: { result: 'ok' } })],
      ],
      ['Pivot: try a different entry point'],
    );
    const session = makeFakeSession([makeBrief]);
    const cfg = baseConfig({
      loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 },
      reflect: { enabled: true, model: 'reflect-model-x', budgetTurnFraction: 0.99 },
    });
    cfg.models.primary.model = 'planner-model';
    await run({ session, task: 'x', config: cfg });
    const reflectReq = reqs.find(q => !q.tools || q.tools.length === 0);
    assert.ok(reflectReq, 'a reflection request was made');
    assert.strictEqual(reflectReq.model, 'reflect-model-x', 'reflection used its own model');
    const planReq = reqs.find(q => q.tools && q.tools.length > 0);
    assert.strictEqual(planReq.model, 'planner-model', 'planning used the planner model');
  });

  await test('clipSaved keeps every heading and tail-trims the body', () => {
    const { clipSaved } = require('../lib/reflect');
    const body = 'x'.repeat(5000);
    const md = `### First finding\n${body}\n### Last finding\nrecent detail here`;
    const clipped = clipSaved(md, 200);
    assert.ok(clipped.includes('### First finding'), 'early heading survives');
    assert.ok(clipped.includes('### Last finding'), 'late heading survives');
    assert.ok(clipped.includes('recent detail here'), 'most recent body kept');
    assert.ok(clipped.length < md.length, 'overall content trimmed');
    // Under the limit ⇒ returned unchanged.
    assert.strictEqual(clipSaved('### Only\nshort', 200), '### Only\nshort');
  });
}

async function planSuite() {
  console.log('\nplan (step 0):');

  const { buildReflectMessage } = require('../lib/reflect');
  const { buildReportMessage } = require('../lib/report');

  // Every Step-0 / reflect / report call is tool-less; classify by a unique
  // marker in each one's system prompt so a run with several of them is legible.
  const isPlanReq = (q) => (!q.tools || !q.tools.length) && /Reply with the plan only/.test(q.system || '');
  const isReflectReq = (q) => (!q.tools || !q.tools.length) && /pausing mid-task to reflect/.test(q.system || '');
  const isReportReq = (q) => (!q.tools || !q.tools.length) && /You write final Markdown reports/.test(q.system || '');
  const isPlannerReq = (q) => q.tools && q.tools.length > 0;

  await test('buildSystemPrompt: plan sits before context, context stays last', () => {
    const reg = { click: registry.click, done: registry.done };
    const base = buildSystemPrompt(reg);
    const plan = 'Start at official docs, capture version numbers, deliver a dated changelog table.';
    const ctx = 'The user is Taylor.';
    const withPlan = buildSystemPrompt(reg, ctx, plan);
    assert.ok(withPlan.startsWith(base), 'static template stays an intact prefix');
    assert.ok(withPlan.includes('Plan of Action ('), 'plan header present');
    assert.ok(withPlan.includes(plan), 'plan prose present');
    assert.ok(withPlan.endsWith(ctx), 'context is still the very last block');
    assert.ok(withPlan.indexOf('Plan of Action') < withPlan.indexOf('Context ('), 'plan precedes context');
  });

  await test('buildSystemPrompt: empty/blank plan is omitted (identical to no plan)', () => {
    const reg = { click: registry.click, done: registry.done };
    const withCtx = buildSystemPrompt(reg, 'ctx');
    assert.strictEqual(buildSystemPrompt(reg, 'ctx', null), withCtx, 'null plan → identical');
    assert.strictEqual(buildSystemPrompt(reg, 'ctx', '   '), withCtx, 'blank plan → identical');
    assert.ok(!buildSystemPrompt(reg).includes('Plan of Action'), 'no plan header when absent');
  });

  await test('buildReflectMessage / buildReportMessage carry the plan only when present', () => {
    const plan = 'Compare three vendors on price and SLA; deliver a recommendation.';
    const rfWith = buildReflectMessage({ task: 't', plan, url: 'u', title: 'T', saved: 's' });
    assert.ok(rfWith.content.includes('plan of action for this run'), 'reflect labels the plan');
    assert.ok(rfWith.content.includes(plan), 'reflect includes the plan prose');
    const rfNo = buildReflectMessage({ task: 't', url: 'u', title: 'T', saved: 's' });
    assert.ok(!rfNo.content.includes('plan of action for this run'), 'reflect omits the plan block when absent');

    const rpWith = buildReportMessage({ task: 't', plan, status: 'completed', evidence: 'e' });
    assert.ok(rpWith.content.includes("agent's plan of action"), 'report labels the plan');
    assert.ok(rpWith.content.includes(plan), 'report includes the plan prose');
    const rpNo = buildReportMessage({ task: 't', status: 'completed', evidence: 'e' });
    assert.ok(!rpNo.content.includes("agent's plan of action"), 'report omits the plan block when absent');
  });

  await test('step 0 threads the plan into the planner system prompt and the report', async () => {
    const PLAN = 'Begin at the official pricing page, corroborate on one review site, capture each tier price and included seats, then deliver a tier comparison table.';
    const reqs = installFakeProvider(
      [
        [action('save_text', { args: { content: 'Tier A $10', summary: 'Tier A' } })],
        [action('done', { args: { result: 'ok' } })],
      ],
      [PLAN, '# Report\n\n- Tier A'],   // no-tools queue: [0]=plan, [1]=report
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-plan-'));
    try {
      const r = await run({
        session: makeFakeSession([makeBrief, makeBrief]),
        task: 'compare pricing tiers',
        config: {
          ...baseConfig({
            plan: { enabled: true },
            report: { enabled: true, provider: 'fake', model: 'report-model' },
          }),
          scratchpad: { enabled: true, dir },
        },
      });
      assert.strictEqual(r.status, 'completed', r.error);
      assert.strictEqual(r.plan, PLAN, 'plan is recorded on the run artifact');

      const planReq = reqs.find(isPlanReq);
      assert.ok(planReq, 'a Step-0 plan call was made');
      assert.ok(planReq.messages[0].content.includes('compare pricing tiers'), 'plan call sees the task');

      // Every planner turn carries the plan inside its (cached) system prompt.
      const planner = reqs.filter(isPlannerReq);
      assert.ok(planner.length >= 2, 'planner ran at least twice');
      for (const q of planner) {
        assert.ok(q.system.includes('Plan of Action ('), 'planner system has the Plan of Action block');
        assert.ok(q.system.includes(PLAN), 'planner system carries the plan prose');
      }

      // The final report call sees the plan too — the report-quality payoff.
      const reportReq = reqs.find(isReportReq);
      assert.ok(reportReq, 'a report call was made');
      assert.ok(reportReq.messages[0].content.includes(PLAN), 'report message carries the plan');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('step 0 threads the plan into a reflection turn', async () => {
    const PLAN = 'Search the docs, then pivot to the changelog if the docs are thin.';
    const reqs = installFakeProvider(
      [
        [action('click', { ref: '@e1' })],   // turns 1-3: same dead click, no page change
        [action('click', { ref: '@e1' })],
        [action('click', { ref: '@e1' })],
        [action('scroll', { args: { direction: 'down' } })],   // the pivot
        [action('done', { args: { result: 'ok' } })],
      ],
      [PLAN, 'Pivot: scroll down to reveal the list'],   // [0]=plan, [1]=reflection decision
    );
    const r = await run({
      session: makeFakeSession([makeBrief]),
      task: 'x',
      config: baseConfig({
        loop: { shortCircuitOnNoChange: true, pollMs: 0, maxNoChangePolls: 1, maxStuckRepeats: 2 },
        plan: { enabled: true },
        reflect: { enabled: true, maxReflections: 10, cooldownTurns: 4, budgetTurnFraction: 0.99 },
      }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.plan, PLAN);
    const reflectReq = reqs.find(isReflectReq);
    assert.ok(reflectReq, 'a reflection turn fired');
    assert.ok(reflectReq.messages[0].content.includes(PLAN), 'reflection message carries the plan');
  });

  await test('step 0 disabled → no plan call and no Plan of Action block', async () => {
    const reqs = installFakeProvider([[action('done', { args: { result: 'ok' } })]]);
    const r = await run({
      session: makeFakeSession([makeBrief]),
      task: 'x',
      config: baseConfig({ plan: { enabled: false } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.plan, null, 'no plan recorded when disabled');
    assert.ok(!reqs.some(isPlanReq), 'no Step-0 plan call was made');
    assert.ok(reqs.filter(isPlannerReq).every(q => !q.system.includes('Plan of Action')), 'planner system has no plan block');
  });

  await test('step 0 failure never breaks the run (proceeds with no plan)', async () => {
    const reqs = installFakeProvider([[action('done', { args: { result: 'ok' } })]]);
    const r = await run({
      session: makeFakeSession([makeBrief]),
      task: 'x',
      // A bogus plan provider makes the Step-0 call throw; the loop must swallow it.
      config: baseConfig({ plan: { enabled: true, provider: 'no-such-provider' } }),
    });
    assert.strictEqual(r.status, 'completed', r.error);
    assert.strictEqual(r.plan, null, 'no plan recorded when Step 0 fails');
    assert.ok(reqs.filter(isPlannerReq).every(q => !q.system.includes('Plan of Action')), 'planner ran without a plan block');
  });
}

async function backSuite() {
  console.log('\nback + history:');
  const cdp = require('../lib/executors/cdp');
  const osExec = require('../lib/executors/os');

  const historyClient = ({ currentIndex, entries, onNavigate } = {}) => ({
    Page: {
      enable: async () => {},
      getNavigationHistory: async () => ({ currentIndex, entries }),
      navigateToHistoryEntry: async ({ entryId }) => { onNavigate && onNavigate(entryId); },
    },
    // readyState 'complete' lets waitUntilLoaded short-circuit (bfcache restore).
    Runtime: { evaluate: async () => ({ result: { value: 'complete' } }) },
  });

  await test('back navigates to the previous history entry', async () => {
    let toEntry = null;
    const session = { client: historyClient({
      currentIndex: 2,
      entries: [{ id: 10 }, { id: 11 }, { id: 12 }],
      onNavigate: (id) => { toEntry = id; },
    }) };
    await back({ session });
    assert.strictEqual(toEntry, 11);  // entries[currentIndex - 1]
  });

  await test('back throws (non-fatal) when there is no previous page and no other tabs', async () => {
    const session = { client: historyClient({ currentIndex: 0, entries: [{ id: 10 }] }) };
    await assert.rejects(() => back({ session }), /no previous page/);
  });

  await test('back closes the tab and follows when no history but other tabs exist', async () => {
    let closedId = null;
    let followed = false;
    const session = {
      client: {
        ...historyClient({ currentIndex: 0, entries: [{ id: 10 }] }),
        Target: {
          getTargets: async () => ({ targetInfos: [
            { type: 'page', targetId: 'tab-A' },
            { type: 'page', targetId: 'tab-B' },
          ]}),
          closeTarget: async ({ targetId }) => { closedId = targetId; },
        },
      },
      _target: { id: 'tab-A' },
      followActiveTab: async () => { followed = true; },
    };
    await back({ session });   // must not throw
    assert.strictEqual(closedId, 'tab-A', 'closed the no-history tab');
    assert.ok(followed, 'followActiveTab called to re-pin the session');
  });

  await test('back validates with no ref or args', () => {
    const { ok, errors } = validate([action('back')], {}, registry);
    assert.strictEqual(errors.length, 0, JSON.stringify(errors));
    assert.strictEqual(ok.length, 1);
  });

  await test('both backends dispatch back + select_text (old selectText key gone)', () => {
    const os = osExec.create({});
    for (const verb of ['back', 'select_text']) {
      assert.strictEqual(typeof cdp[verb], 'function', `cdp exposes ${verb}`);
      assert.strictEqual(typeof os[verb], 'function', `os exposes ${verb}`);
    }
    assert.strictEqual(cdp.selectText, undefined, 'cdp: old selectText key removed');
    assert.strictEqual(os.selectText, undefined, 'os: old selectText key removed');
  });
}

async function memorySuite() {
  console.log('\nmemory (event log):');

  await test('prompt carries the event log + current page, not a transcript', async () => {
    const reqs = installFakeProvider([
      [action('type', { ref: '@e1', args: { text: 'hello', intent: 'test search input' } })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'find hello', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);

    // turn 1: exactly one user message, no replayed assistant turns
    assert.strictEqual(reqs[0].messages.length, 1);
    assert.strictEqual(reqs[0].messages[0].role, 'user');
    const t1 = reqs[0].messages[0].content;
    assert.ok(t1.includes('find hello'), 'task present');
    assert.match(t1, /nothing yet/, 'empty progress on first turn');
    assert.ok(t1.includes('@e1'), 'current page listing present');

    // turn 2: progress now records the type; still one user message, no replay
    assert.strictEqual(reqs[1].messages.length, 1);
    assert.ok(!reqs[1].messages.some(m => m.role === 'assistant'), 'no transcript replay');
    assert.match(reqs[1].messages[0].content, /typed "hello" into "Search"/);
    assert.match(reqs[1].messages[0].content, /intent: test search input/);
  });

  await test('prompt carries bounded intent history without truncating older intents', async () => {
    const firstIntent = 'collect exact title then inspect next candidate';
    const secondIntent = 'open next visible candidate';
    const reqs = installFakeProvider([
      [action('click', { ref: '@e1', args: { intent: firstIntent } })],
      [action('scroll', { args: { direction: 'down', intent: secondIntent } })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief, makeBrief]);
    const r = await run({ session, task: 'collect candidates', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);

    const t3 = reqs[2].messages[0].content;
    assert.match(t3, /1\. clicked "Search" — intent: collect exact title then inspect next candidate/);
    assert.match(t3, /2\. scrolled down — intent: open next visible candidate/);
  });

  await test('history uses cleaned navigate URLs and readable select_text targets', async () => {
    const noisyUrl = 'https://example.test/results?q=browser+agent&utm_source=newsletter&fbclid=abc#section';
    const reqs = installFakeProvider([
      [action('click', { ref: '@e1', args: { intent: 'open noisy result URL' } })],
      [action('select_text', { ref: '@t1', args: { intent: 'read heading' } })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([
      makeBrief(),
      makeBrief({ url: noisyUrl }),
      makeBrief({ url: noisyUrl }),
    ]);
    const r = await run({ session, task: 'inspect result', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);

    const t3 = reqs[2].messages[0].content;
    assert.match(t3, /1\. clicked "Search" — intent: open noisy result URL/);
    assert.match(t3, /page navigated to https:\/\/example\.test\/results\?q=browser\+agent/);
    assert.match(t3, /selected "Welcome" — intent: read heading — selected: "Welcome"/);
    assert.ok(!t3.includes('utm_source'), 'history should drop tracking params');
    assert.ok(!t3.includes('fbclid'), 'history should drop click ids');
    assert.ok(!t3.includes('#section'), 'history should drop fragments');
  });

  await test('save_text history includes a bounded content preview', async () => {
    const important = 'repo one: alpha stars 10; repo two: beta stars 20';
    const longTail = ' x'.repeat(800);
    const reqs = installFakeProvider([
      [action('save_text', {
        args: {
          intent: 'store repo facts',
          content: important + longTail,
          summary: 'Captured repo facts',
        },
      })],
      [action('done', { args: {} })],
    ]);
    const r = await run({ session: makeFakeSession([makeBrief, makeBrief]), task: 'remember facts', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);

    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /saved text — intent: store repo facts — "Captured repo facts" — saved: "repo one: alpha stars 10; repo two: beta stars 20/);
    assert.ok(t2.includes('…'), 'long saved content should be bounded');
    assert.ok(t2.length < 5000, 'preview should not dump the full saved note');
  });

  await test('turn log includes the simplified LLM payload', async () => {
    installFakeProvider([[action('done', { args: {} })]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-log-'));
    const session = makeFakeSession([makeBrief]);
    const r = await run({
      session,
      task: 'find hello',
      config: { ...baseConfig(), log: { enabled: true, dir } },
    });
    assert.strictEqual(r.status, 'completed', r.error);

    const file = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'));
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(JSON.parse);
    const turn = lines.find(l => l.kind === 'turn');
    assert.strictEqual(turn.llmPayload.messages.length, 1);
    assert.ok(turn.llmPayload.estimatedTokens > 0);
    assert.strictEqual(turn.llmPayload.messages[0].role, 'user');
    assert.ok(turn.llmPayload.messages[0].content.includes('find hello'));
    assert.ok(turn.llmPayload.messages[0].content.includes('@e1'));
  });

  await test('only the current page is included, not prior snapshots', async () => {
    const reqs = installFakeProvider([
      [action('scroll', { args: { direction: 'down' } })],  // event has no ref
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    await run({ session, task: 'x', config: baseConfig() });
    // '@e1' lives only in the page listing; it must appear once in turn 2's
    // prompt (current page), not twice (current + a replayed prior snapshot).
    const t2 = reqs[1].messages[0].content;
    assert.strictEqual((t2.match(/@e1/g) || []).length, 1, 'no accumulated snapshots');
  });

  await test('navigation between turns is recorded as an event', async () => {
    const reqs = installFakeProvider([
      [action('click', { ref: '@e1' })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([
      makeBrief({ url: 'http://example.test/a' }),
      makeBrief({ url: 'http://example.test/b' }),
    ]);
    const r = await run({ session, task: 'go', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /navigated to http:\/\/example\.test\/b/);
    assert.match(t2, /clicked "Search"/);
  });

  await test('a rejected action is recorded with its reason', async () => {
    const reqs = installFakeProvider([
      [action('type', { ref: '@t1', args: { text: 'x' } })],   // type is @e-only ⇒ rejected
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /rejected:/);
    assert.match(t2, /typed "x" into "Welcome"/);   // @t1's name is "Welcome"
  });

  await test('a rejected wait without ms renders cleanly', async () => {
    const reqs = installFakeProvider([
      [action('wait', { args: {} })],
      [action('done', { args: {} })],
    ]);
    const session = makeFakeSession([makeBrief, makeBrief]);
    const r = await run({ session, task: 'x', config: baseConfig() });
    assert.strictEqual(r.status, 'completed', r.error);
    const t2 = reqs[1].messages[0].content;
    assert.match(t2, /waited — intent: test intent — rejected: missing required arg "ms"/);
    assert.ok(!t2.includes('waited ms'), 'should not render awkward missing-ms wording');
  });
}

// Provider wire-format translation lives in _shared.js and feeds all three
// providers. A regression here silently breaks a whole provider, and the loop
// tests use a fake provider that never exercises it — so test it directly.
async function providerTranslationSuite() {
  console.log('\nprovider translation (_shared):');
  const { buildJsonSchema, hoistRef, openaiStyleMessages, parseOpenAIStyleToolCalls } = shared;

  await test('buildJsonSchema marks optional (?) fields not-required', () => {
    const s = buildJsonSchema({ text: 'string', amount: 'number?' });
    assert.deepStrictEqual(s.required, ['text']);
    assert.strictEqual(s.properties.amount.type, 'number');
  });

  await test('toolsFromRegistry exposes optional screenshot ref', () => {
    const [tool] = modelMod.toolsFromRegistry({ take_screenshot: registry.take_screenshot });
    assert.deepStrictEqual(tool.inputSchema, { ref: 'string?', intent: 'string', hint: 'string?' });
    const schema = buildJsonSchema(tool.inputSchema);
    assert.deepStrictEqual(schema.required, ['intent']);
    assert.strictEqual(schema.properties.ref.type, 'string');
    assert.strictEqual(schema.properties.intent.type, 'string');
  });

  await test('hoistRef splits ref from the rest of the args', () => {
    assert.deepStrictEqual(hoistRef({ ref: '@e1', text: 'hi' }), { ref: '@e1', args: { text: 'hi' } });
    assert.deepStrictEqual(hoistRef({ direction: 'down' }), { ref: undefined, args: { direction: 'down' } });
  });

  await test('openaiStyleMessages: system hoisted, string content passthrough', () => {
    const out = openaiStyleMessages('SYS', [{ role: 'user', content: 'hello' }], { argsAsString: true });
    assert.deepStrictEqual(out, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hello' }]);
  });

  await test('openaiStyleMessages: assistant tool_use → tool_calls (args stringified)', () => {
    const msgs = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'click', input: { ref: '@e1' } }] }];
    const out = openaiStyleMessages(null, msgs, { argsAsString: true });
    assert.strictEqual(out[0].content, null, 'OpenAI wants null content alongside tool_calls');
    assert.strictEqual(out[0].tool_calls[0].function.name, 'click');
    assert.strictEqual(out[0].tool_calls[0].function.arguments, JSON.stringify({ ref: '@e1' }));
  });

  await test('openaiStyleMessages: tool_result → standalone role:tool message', () => {
    const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] }];
    const out = openaiStyleMessages(null, msgs, { argsAsString: true });
    assert.strictEqual(out[0].role, 'tool');
    assert.strictEqual(out[0].tool_call_id, 'tu1');
    assert.strictEqual(out[0].content, 'ok');
  });

  await test('parseOpenAIStyleToolCalls: JSON-string args → Action with hoisted ref', () => {
    const calls = [{ id: 'c1', function: { name: 'type', arguments: JSON.stringify({ ref: '@e2', text: 'hi' }) } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: true });
    assert.deepStrictEqual(a, { kind: 'action', verb: 'type', args: { text: 'hi' }, ref: '@e2', toolUseId: 'c1' });
  });

  await test('parseOpenAIStyleToolCalls: object args (ollama) + synthesized id', () => {
    const calls = [{ function: { name: 'scroll', arguments: { direction: 'down' } } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: false, synthId: (i) => 'synth' + i });
    assert.deepStrictEqual(a.args, { direction: 'down' });
    assert.strictEqual(a.toolUseId, 'synth0');
  });

  await test('parseOpenAIStyleToolCalls: malformed JSON args default to {}', () => {
    const calls = [{ id: 'c1', function: { name: 'done', arguments: '{not json' } }];
    const [a] = parseOpenAIStyleToolCalls(calls, { argsAsString: true });
    assert.deepStrictEqual(a.args, {});
  });
}

// Gemini's wire format is distinct enough (contents/parts, systemInstruction,
// wrapped tools, functionCall/functionResponse, user/model roles) that the
// shared OpenAI/Anthropic translation doesn't cover it. Test the translation
// directly, plus one fetch-stubbed round-trip — keyless, no network.
async function geminiSuite() {
  console.log('\ngemini provider:');
  const gemini = require('../lib/providers/gemini');

  await test('toGeminiTool produces { name, description, parameters }', () => {
    const t = gemini.toGeminiTool({ name: 'click', description: 'd', inputSchema: { ref: 'string', hint: 'string?' } });
    assert.strictEqual(t.name, 'click');
    assert.strictEqual(t.parameters.type, 'object');
    assert.deepStrictEqual(t.parameters.required, ['ref'], 'optional ? field not required');
  });

  await test('toGeminiContents: string content maps role assistant→model', () => {
    const out = gemini.toGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'there' },
    ]);
    assert.deepStrictEqual(out, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'there' }] },
    ]);
  });

  await test('toGeminiContents: assistant tool_use → model functionCall part', () => {
    const out = gemini.toGeminiContents([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'click', input: { ref: '@e1' } }] },
    ]);
    assert.deepStrictEqual(out, [{ role: 'model', parts: [{ functionCall: { name: 'click', args: { ref: '@e1' } } }] }]);
  });

  await test('toGeminiContents: tool_result → user functionResponse part', () => {
    const out = gemini.toGeminiContents([
      { role: 'user', content: [{ type: 'tool_result', name: 'click', content: 'ok' }] },
    ]);
    assert.strictEqual(out[0].role, 'user');
    assert.deepStrictEqual(out[0].parts[0].functionResponse, { name: 'click', response: { result: 'ok' } });
  });

  await test('parseActions: functionCall args (object) → Action with hoisted ref', () => {
    const [a] = gemini.parseActions([{ functionCall: { name: 'type', args: { ref: '@e2', text: 'hi' } } }]);
    assert.deepStrictEqual(a, { kind: 'action', verb: 'type', args: { text: 'hi' }, ref: '@e2', toolUseId: 'type' });
  });

  await test('plan: builds Gemini request and parses the response (fetch stubbed)', async () => {
    const origFetch = global.fetch;
    const origKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    let captured;
    global.fetch = async (url, opts) => {
      captured = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      return {
        ok: true, status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ functionCall: { name: 'done', args: { result: 'ok' } } }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3, cachedContentTokenCount: 7 },
        }),
        text: async () => '',
        headers: { get: () => null },
      };
    };
    try {
      const out = await gemini.callModel({
        system: 'SYS',
        tools: [{ name: 'done', description: 'finish', inputSchema: { result: 'string?' } }],
        messages: [{ role: 'user', content: 'go' }],
        model: 'gemini-3.1-pro',
      });
      // request shape
      assert.ok(captured.url.endsWith('/v1beta/models/gemini-3.1-pro:generateContent'), 'model in URL path');
      assert.strictEqual(captured.headers['x-goog-api-key'], 'test-key', 'auth via x-goog-api-key header');
      assert.deepStrictEqual(captured.body.systemInstruction, { parts: [{ text: 'SYS' }] }, 'system → systemInstruction');
      assert.ok(Array.isArray(captured.body.tools[0].functionDeclarations), 'tools wrapped in functionDeclarations');
      assert.strictEqual(captured.body.toolConfig.functionCallingConfig.mode, 'ANY', 'forced tool call');
      assert.strictEqual(captured.body.generationConfig.maxOutputTokens, 4096, 'maxTokens default → maxOutputTokens');
      // response parsing
      assert.deepStrictEqual(out.actions, [{ kind: 'action', verb: 'done', args: { result: 'ok' }, toolUseId: 'done' }]);
      assert.strictEqual(out.provider, 'gemini');
      assert.deepStrictEqual(out.usage, { inputTokens: 11, outputTokens: 3, cacheCreationTokens: null, cacheReadTokens: 7 });
    } finally {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origKey;
    }
  });
}

// Vision is now unified onto adapter.describe() + registry dispatch (Phase 5).
// Verify the seam: every provider advertises vision, and vision.describe routes
// through the adapter and normalizes its text.
async function visionDispatchSuite() {
  console.log('\nvision dispatch (unified describe):');
  const visionMod = require('../lib/vision');
  const { providers } = require('../lib/model');

  await test('every built-in provider advertises vision + describe()', () => {
    // Built-ins only — an earlier suite injects a partial `fake` adapter into the
    // shared registry, which deliberately has no capabilities block.
    for (const name of ['openai', 'anthropic', 'ollama', 'gemini']) {
      const a = providers[name];
      assert.strictEqual(a.capabilities.vision, true, `${name} should support vision`);
      assert.strictEqual(typeof a.describe, 'function', `${name} should implement describe()`);
      assert.ok(a.defaultVisionModel, `${name} should declare a defaultVisionModel`);
    }
  });

  await test('vision.describe routes through the configured adapter and normalizes', async () => {
    // Config resolves vision.provider to openai (see browser-agent.config.json), so
    // stub that adapter's describe() and assert vision.js orchestrates around it.
    const openai = providers.openai;
    const origDescribe = openai.describe;
    let seen;
    openai.describe = async (req) => { seen = req; return { kind: 'vision', text: '{"summary":"a login page","description":"full detail"}' }; };
    try {
      const out = await visionMod.describe({ imageBase64: 'BASE64', mimeType: 'image/jpeg', hint: 'the button' });
      assert.strictEqual(seen.model, 'gpt-5.4-mini', 'config model forwarded to the adapter');
      assert.strictEqual(seen.imageBase64, 'BASE64');
      assert.strictEqual(seen.cacheKey, 'browser-agent:vision');
      assert.strictEqual(seen.maxTokens, 1024, 'config maxTokens forwarded');
      assert.match(seen.prompt, /Focus especially on: the button/, 'hint folded into prompt');
      assert.deepStrictEqual(out, { summary: 'a login page', description: 'full detail' });
    } finally {
      openai.describe = origDescribe;
    }
  });
}

async function cacheSuite() {
  console.log('\nprompt caching (provider breakpoints):');
  const { toAnthropicTools } = require('../lib/providers/anthropic');

  await test('anthropic: cache breakpoint lands only on the last tool', () => {
    const tools = [
      { name: 'click', inputSchema: { ref: 'string' } },
      { name: 'done', inputSchema: { result: 'string?' } },
    ];
    const out = toAnthropicTools(tools);
    assert.strictEqual(out[0].cache_control, undefined, 'non-last tools carry no breakpoint');
    assert.deepStrictEqual(out[out.length - 1].cache_control, { type: 'ephemeral' },
      'the last tool caches the tool-definitions prefix');
    assert.strictEqual(out[1].name, 'done', 'tool order/content is otherwise preserved');
  });

  await test('anthropic: empty tool list is handled without a breakpoint', () => {
    assert.deepStrictEqual(toAnthropicTools([]), []);
    assert.deepStrictEqual(toAnthropicTools(undefined), []);
  });

  await test('openai: reasoning effort uses Responses API and null stays on Chat', async () => {
    const openai = require('../lib/providers/openai');
    const origFetch = global.fetch;
    const origKey = process.env.OPENAI_API_KEY;
    const origRetention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
    const origRetentionModels = process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS = 'gpt-5.4-mini';
    const captured = [];
    global.fetch = async (url, opts) => {
      captured.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true, status: 200,
        json: async () => String(url).endsWith('/responses')
          ? ({ output: [], usage: {} })
          : ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
        text: async () => '',
        headers: { get: () => null },
      };
    };
    try {
      const base = { system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] };
      await openai.callModel({ ...base, reasoningEffort: 'high', cacheKey: 'run-1' });
      assert.ok(captured[0].url.endsWith('/responses'), 'reasoning requests use Responses API');
      assert.deepStrictEqual(captured[0].body.reasoning, { effort: 'high' }, 'forwarded to the Responses request body');
      assert.strictEqual(captured[0].body.prompt_cache_key, 'run-1', 'Responses receives cache routing key');
      assert.strictEqual(captured[0].body.prompt_cache_retention, '24h', 'Responses receives cache retention');
      await openai.callModel({ ...base, reasoningEffort: null, cacheKey: 'run-1' });
      assert.ok(captured[1].url.endsWith('/chat/completions'), 'null reasoning uses Chat Completions');
      assert.strictEqual('reasoning' in captured[1].body, false, 'omitted when null (non-reasoning models reject it)');
      assert.strictEqual('reasoning_effort' in captured[1].body, false, 'old Chat field remains omitted');
      assert.strictEqual(captured[1].body.prompt_cache_key, 'run-1', 'Chat receives cache routing key');
      assert.strictEqual(captured[1].body.prompt_cache_retention, '24h', 'Chat receives cache retention');
    } finally {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = origKey;
      if (origRetention === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION; else process.env.OPENAI_PROMPT_CACHE_RETENTION = origRetention;
      if (origRetentionModels === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS; else process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS = origRetentionModels;
    }
  });

  await test('openai: prompt cache retention is gated by model allowlist', async () => {
    const openai = require('../lib/providers/openai');
    const origFetch = global.fetch;
    const origKey = process.env.OPENAI_API_KEY;
    const origRetention = process.env.OPENAI_PROMPT_CACHE_RETENTION;
    const origRetentionModels = process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_PROMPT_CACHE_RETENTION = '24h';
    delete process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS;
    let captured;
    global.fetch = async (url, opts) => {
      captured = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }),
        text: async () => '',
        headers: { get: () => null },
      };
    };
    try {
      await openai.callModel({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }], cacheKey: 'run-1' });
      assert.strictEqual(captured.prompt_cache_key, 'run-1', 'cache key is still sent');
      assert.strictEqual('prompt_cache_retention' in captured, false, 'retention is omitted without an allowlist match');
    } finally {
      global.fetch = origFetch;
      if (origKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = origKey;
      if (origRetention === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION; else process.env.OPENAI_PROMPT_CACHE_RETENTION = origRetention;
      if (origRetentionModels === undefined) delete process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS; else process.env.OPENAI_PROMPT_CACHE_RETENTION_MODELS = origRetentionModels;
    }
  });
}

async function normalizeUrlSuite() {
  console.log('\nnormalizeUrl (scheme allowlist):');

  await test('prepends https:// to a bare host', () => {
    assert.strictEqual(normalizeUrl('example.com'), 'https://example.com/');
  });

  await test('keeps an explicit http/https url', () => {
    assert.strictEqual(normalizeUrl('http://example.com/x'), 'http://example.com/x');
  });

  await test('rejects non-web schemes (file/chrome/about/view-source)', () => {
    for (const u of ['file:///etc/passwd', 'chrome://settings', 'about:blank', 'view-source:http://x']) {
      assert.throws(() => normalizeUrl(u), `${u} should be rejected`);
    }
  });

  await test('rejects an empty url', () => {
    assert.throws(() => normalizeUrl('   '), /requires a url/);
  });
}

// Exercises the timeout + retry guard in postJSON by swapping global fetch.
async function postJSONSuite() {
  console.log('\npostJSON (timeout + retry):');
  const { postJSON } = shared;
  const origFetch = global.fetch;
  const res = (status, payload) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },   // no Retry-After
  });

  await test('returns parsed JSON on success without retrying', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return res(200, { ok: true }); };
    try {
      assert.deepStrictEqual(await postJSON('http://x', { body: {}, retries: 2 }), { ok: true });
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });

  await test('retries a 503 then succeeds', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return calls < 3 ? res(503, {}) : res(200, { done: true }); };
    try {
      assert.deepStrictEqual(await postJSON('http://x', { body: {}, retries: 3 }), { done: true });
      assert.strictEqual(calls, 3);
    } finally { global.fetch = origFetch; }
  });

  await test('fails fast on a 400 (no retry)', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return res(400, { error: 'bad' }); };
    try {
      await assert.rejects(() => postJSON('http://x', { body: {}, retries: 3, label: 'Test' }), /Test 400/);
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });

  await test('tags errors with the normalized taxonomy (auth/rate_limit/server)', async () => {
    const cases = [
      [401, 'auth', false],
      [403, 'auth', false],
      [429, 'rate_limit', true],
      [500, 'server', true],
      [404, 'invalid_request', false],
    ];
    for (const [status, type, retriable] of cases) {
      global.fetch = async () => res(status, { error: 'x' });
      try {
        // retries:0 so the terminal throw carries the tag for the retriable ones too
        await postJSON('http://x', { body: {}, retries: 0, label: 'T' });
        assert.fail(`expected ${status} to throw`);
      } catch (err) {
        assert.strictEqual(err.type, type, `${status} → type ${type}`);
        assert.strictEqual(err.status, status);
        assert.strictEqual(err.retriable, retriable, `${status} → retriable ${retriable}`);
      } finally { global.fetch = origFetch; }
    }
  });

  await test('redacts credential-shaped substrings in error messages', async () => {
    global.fetch = async () => res(400, { error: 'bad key sk-ABC123456789 and AIzaSyABC123456789' });
    try {
      await postJSON('http://x?key=SECRETKEY123', { body: {}, retries: 0, label: 'T' });
      assert.fail('expected throw');
    } catch (err) {
      assert.doesNotMatch(err.message, /sk-ABC123456789/, 'OpenAI-style key redacted');
      assert.doesNotMatch(err.message, /AIzaSyABC123456789/, 'Google-style key redacted');
      assert.match(err.message, /sk-\[redacted\]/);
    } finally { global.fetch = origFetch; }
  });

  await test('aborts on timeout and surfaces a timeout error', async () => {
    // Hang until aborted, then reject with the abort reason — like real fetch.
    global.fetch = (_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    try {
      await assert.rejects(
        () => postJSON('http://x', { body: {}, retries: 0, timeoutMs: 20, label: 'Test' }),
        /timed out after 20ms/,
      );
    } finally { global.fetch = origFetch; }
  });

  await test('caller abort is surfaced immediately and not retried', async () => {
    let calls = 0;
    const ac = new AbortController();
    global.fetch = (_url, opts) => new Promise((_, reject) => {
      calls++;
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
    });
    try {
      const p = postJSON('http://x', { body: {}, retries: 3, signal: ac.signal });
      ac.abort(new Error('shutdown'));
      await assert.rejects(() => p, /shutdown/);
      assert.strictEqual(calls, 1);
    } finally { global.fetch = origFetch; }
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

(async () => {
  await reduceSuite();
  await regionSuite();
  await visionSuite();
  await visualEnrichmentSuite();
  await screenshotSuite();
  await osGateSuite();
  await validateSuite();
  await executeSuite();
  await targetingSuite();
  await configSuite();
  await launchSuite();
  await scratchpadSuite();
  await saveFileSuite();
  await logSuite();
  await agentCliSuite();
  await promptSuite();
  await tokenSuite();
  await textSuite();
  await loopSuite();
  await reflectSuite();
  await planSuite();
  await backSuite();
  await memorySuite();
  await providerTranslationSuite();
  await geminiSuite();
  await visionDispatchSuite();
  await cacheSuite();
  await normalizeUrlSuite();
  await postJSONSuite();
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
