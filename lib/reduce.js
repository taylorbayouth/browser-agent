'use strict';

const crypto = require('crypto');
const { cleanUrl } = require('./url');

// Turn a Brief into an LLMView — the prompt-ready, deterministic, text-formatted
// representation. The lookup table is intentionally absent (executor-only).
//
// Slice 1: elements only. Text nodes are omitted from the listing — they're
// grounding context the LLM doesn't need yet.
//
// See DESIGN.md § Artifacts § LLMView.

// Compute briefHash from content. This is a whitelist: only url, title,
// viewport, and per-element/text content go in. Ephemeral fields (timestamp,
// elapsedMs, stats) are excluded by construction — they're never read here — so
// re-snapshotting the same page yields the same hash and the loop can
// short-circuit redundant LLM calls. `bbox` is also dropped: the LLM's listing
// carries no coordinates, so two layouts with identical elements/labels are the
// same as far as the model is concerned, and must hash the same.
function computeBriefHash(brief) {
  // viewport is intentionally excluded: width/height changes on window resize
  // and scrollX/Y changes are already captured via the in-viewport element list
  // (inViewportOnly:true). Including them caused false "page changed" signals
  // on resize, burning an extra LLM turn on identical content.
  const stable = {
    url: brief.url,
    title: brief.title,
    elements: brief.elements?.map(e => ({ ...e, bbox: undefined })) ?? [],
    text: brief.text?.map(t => ({ ...t, bbox: undefined })) ?? [],
    // Regions carry no ref or name — only role distinguishes them — so a page
    // gaining or losing an unreadable graphic flips the hash and re-prompts.
    regions: brief.regions?.map(r => ({ role: r.role })) ?? [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

const DEFAULT_VIEW = {
  includeText: true,    // interleave @t text nodes (headings, labels, prose)
  includeCoords: true,  // append a compact (x,y) center per line
  maxTextChars: 200,    // truncate long text node names
  dedupeText: true,     // collapse consecutive identical text nodes
  maxListingLines: 1000, // hard cap on lines sent to the LLM (0 = unlimited)
};

function bboxFromAny(b) {
  if (!b) return null;
  if (Array.isArray(b)) return { x: b[0], y: b[1], width: b[2], height: b[3] };
  return b;
}

function center(bbox) {
  const b = bboxFromAny(bbox);
  if (!b) return null;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Reading-order sort key: band rows by ~10px so items on the same visual line
// sort left-to-right rather than by sub-pixel baseline differences. Nodes
// without a bbox sort last.
function sortKey(bbox) {
  const c = center(bbox);
  // Large finite sentinel (not Infinity): two bbox-less nodes would otherwise
  // compute Infinity - Infinity = NaN in the comparator, which is spec-undefined
  // and yields nondeterministic ordering. MAX_SAFE_INTEGER still sorts them last.
  if (!c) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Math.round(c.y / 10), c.x];
}

function truncate(s, max) {
  if (!max || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Collapse internal whitespace (newlines, tabs, runs of spaces) to single
// spaces and trim. The listing is addressed line-by-line as `[@ref] …`, so an
// accessible name carrying a raw newline — a wrapped button/link label, a
// textarea value, alt text with hard breaks — would otherwise split one element
// across multiple lines and break the model's ref-to-element attribution.
// Mirrors loop.js's compactWhitespace.
function cleanName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function coordSuffix(bbox, view) {
  if (!view.includeCoords) return '';
  const c = center(bbox);
  if (!c) return '';
  return `  (${Math.round(c.x)},${Math.round(c.y)})`;
}

// Plain-language marker for the AX haspopup token, so the model knows a click
// opens something (and what kind) instead of navigating. "listbox" is shown as
// "list" to stay jargon-free; an unknown or bare "true" token falls back to a
// generic note.
function popupLabel(token) {
  const kind = { menu: 'menu', listbox: 'list', tree: 'tree', grid: 'grid', dialog: 'dialog' }[token];
  return kind ? `(opens ${kind})` : '(opens popup)';
}

// Trailing marker for an element that is in the brief but below the current
// view. The perception band reaches one screen past the fold, so such an element
// is real and actionable (the executor scrolls it into view first) — it just
// isn't on screen yet. The coordinate already encodes position; this makes "not
// visible right now" explicit so the model doesn't assume every line is on screen.
function foldSuffix(node) {
  return node.inViewport === false ? ' ↓' : '';
}

// A link we clicked that didn't navigate: demote to a non-clickable line. The
// URL stays visible (full, not display-truncated) so the model can navigate to
// it directly, but with no [@ref] there's nothing to re-click — which breaks the
// dead-click loop without removing the lead.
function formatDeadLink(el, view) {
  const clean = cleanName(el.name);
  const name = clean ? `"${truncate(clean, view.maxTextChars).replace(/"/g, '\\"')}"` : '(unnamed)';
  const url = cleanUrl(el.url, { max: 0 });
  return `  link (dead)  ${name}  -> ${url}  — clicking did nothing; navigate to this URL${coordSuffix(el.bbox, view)}${foldSuffix(el)}`;
}

// Interactive element line: ref, role, name, state extras, optional coords.
function formatInteractive(el, view, deadLinks) {
  if (deadLinks && el.url && deadLinks.has(el.url)) return formatDeadLink(el, view);
  const role = (el.role || '?').padEnd(10);
  const clean = cleanName(el.name);
  // Truncate like text nodes do: a "stretched-link" card's accessible name is
  // often the entire card's text (hundreds of chars), which bloats tokens and
  // buries the listing — cap it at the same maxTextChars budget.
  const name = clean ? `"${truncate(clean, view.maxTextChars).replace(/"/g, '\\"')}"` : '(unnamed)';
  const extras = [];
  if (el.value) extras.push(`= "${truncate(cleanName(el.value), view.maxTextChars).replace(/"/g, '\\"')}"`);
  if (el.url) extras.push(`-> ${cleanUrl(el.url)}`);
  if (el.checked) extras.push('(checked)');
  if (el.selected) extras.push('(selected)');
  if (el.expanded) extras.push('(expanded)');
  // haspopup/invalid may arrive as a boolean (lean) or the raw AX token (full);
  // the "false" string is truthy, so exclude it explicitly.
  if (el.haspopup && el.haspopup !== 'false') extras.push(popupLabel(el.haspopup));
  if (el.required) extras.push('(required)');
  if (el.invalid && el.invalid !== 'false') extras.push('(invalid)');
  if (el.disabled) extras.push('(disabled)');
  if (el.focused) extras.push('(focused)');
  const suffix = extras.length ? '  ' + extras.join(' ') : '';
  return `[${el.ref}]  ${role}  ${name}${suffix}${coordSuffix(el.bbox, view)}${foldSuffix(el)}`;
}

// Text context line: ref, role, truncated name, optional coords. No action
// extras — @t refs are read-only context, not targets (the validator enforces
// this).
function formatText(t, view) {
  const role = (t.role || 'text').padEnd(10);
  const raw = cleanName(t.name);
  const name = `"${truncate(raw, view.maxTextChars).replace(/"/g, '\\"')}"`;
  return `[${t.ref}]  ${role}  ${name}${coordSuffix(t.bbox, view)}${foldSuffix(t)}`;
}

// Visual line: a rendered graphic the accessibility tree can't describe in text.
// Its @v ref is accepted only by take_screenshot, which crops the capture to the
// graphic. A NAMED visual (logo/photo) is captured to SHOW it in the report; an
// unnamed one is captured to READ it. The optional label echoes its name/title.
function formatRegion(r, view) {
  const ref = r.ref || '@v?';
  const role = (r.role || 'region').padEnd(10);
  const b = bboxFromAny(r.bbox);
  const dims = b ? `${Math.round(b.width)}×${Math.round(b.height)} ` : '';
  const label = r.label ? `"${truncate(r.label, 60).replace(/"/g, '\\"')}" ` : '';
  const note = r.named ? `take_screenshot ${ref} to capture` : `unreadable; take_screenshot ${ref} to read`;
  return `[${ref}]  ${role}  ${dims}${label}— ${note}${coordSuffix(r.bbox, view)}${foldSuffix(r)}`;
}

function reduce(brief, viewCfg = {}, deadLinks = null) {
  const view = { ...DEFAULT_VIEW, ...viewCfg };
  const elements = brief.elements ?? [];
  const text = view.includeText ? (brief.text ?? []) : [];
  const regions = brief.regions ?? [];

  // Merge elements, text, and unreadable regions into one reading-order list so
  // labels sit next to the fields they describe and a graphic appears where it
  // is on the page (telling the model whether to scroll before screenshotting).
  const merged = [
    ...elements.map(node => ({ kind: 'e', node, key: sortKey(node.bbox) })),
    ...text.map(node => ({ kind: 't', node, key: sortKey(node.bbox) })),
    ...regions.map(node => ({ kind: 'v', node, key: sortKey(node.bbox) })),
  ].sort((a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]));

  const lines = [];
  let lastText = null; // for consecutive-dedupe; reset by any element so only
                       // directly-adjacent repeats collapse (spatially separated
                       // identical strings — e.g. per-row prices — are kept).
  for (const { kind, node } of merged) {
    if (kind === 't') {
      const raw = cleanName(node.name);                    // same normalization formatText uses
      if (!raw) continue;                                  // drop empty/whitespace
      if (view.dedupeText && raw === lastText) continue;   // collapse adjacent repeat
      lastText = raw;
      lines.push(formatText(node, view));
    } else if (kind === 'v') {
      lastText = null;
      lines.push(formatRegion(node, view));
    } else {
      lastText = null;
      lines.push(formatInteractive(node, view, deadLinks));
    }
  }

  // Cap the listing. A dense page (data grid, infinite feed) can produce
  // hundreds of in-viewport lines, inflating cost and — on a pathological page —
  // risking the context window mid-run. Truncate in reading order (top of the
  // page is what matters most) and tell the model the view was clipped so it can
  // scroll for the rest rather than assume it saw everything.
  const cap = view.maxListingLines;
  if (cap > 0 && lines.length > cap) {
    const dropped = lines.length - cap;
    lines.length = cap;
    lines.push(`… (${dropped} more elements not shown — scroll to reveal them)`);
  }

  return {
    kind: 'llm-view',
    version: '1.0',
    briefHash: brief.briefHash ?? computeBriefHash(brief),
    url: brief.url ?? null,
    title: brief.title ?? null,
    viewport: brief.viewport,
    listing: lines.join('\n'),
  };
}

module.exports = { reduce, computeBriefHash, DEFAULT_VIEW };
