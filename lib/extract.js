'use strict';

// Lowercase ARIA roles. CDP emits 'StaticText' etc. in CamelCase for
// Chrome-internal roles; ARIA roles are all lowercase.
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox',
  'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'searchbox', 'slider', 'spinbutton', 'switch',
  'treeitem', 'option', 'columnheader', 'rowheader',
]);

// Roles that signal "no semantics" — a focusable element with one of these
// is a custom widget (e.g. <div tabindex="0">). Landmark/region roles are
// intentionally excluded: they're page containers, not click targets.
const NON_SEMANTIC_ROLES = new Set(['generic', 'none', 'presentation', '', undefined, null]);

// 'StaticText' is Chrome-internal (CamelCase); the rest are ARIA lowercase.
// InlineTextBox / LineBreak are sub-runs of StaticText and are omitted.
const TEXT_ROLES = new Set([
  'heading', 'paragraph', 'StaticText', 'label', 'caption',
  'listitem', 'term', 'definition', 'blockquote', 'code',
]);

// Roles preserved as structural parents in tree mode. Everything else is
// pass-through: the node is skipped but its descendants bubble up.
const CONTAINER_ROLES = new Set([
  'RootWebArea',
  'main', 'navigation', 'banner', 'complementary', 'contentinfo',
  'region', 'search', 'form',
  'article', 'section', 'list', 'listitem', 'group', 'figure',
  'dialog', 'alertdialog', 'tabpanel', 'tablist', 'menu', 'menubar',
  'radiogroup', 'listbox', 'tree', 'treegrid', 'grid', 'table',
  'row', 'rowgroup', 'sectionheader', 'sectionfooter', 'status',
]);

const STYLE_PROPS = [
  'cursor', 'display', 'visibility', 'opacity', 'pointer-events',
  'position', 'z-index', 'background-color', 'background-image',
  'background-repeat', 'color',
  'font-size', 'font-weight', 'border-radius', 'overflow',
];

const MIN_CSS_BACKGROUND_PX = 32;
const REGION_SOURCE_URL_PROP = '__browserAgentSourceUrl';

// Tags whose rendered content the accessibility tree cannot describe: a
// <canvas> is raw pixels, an <img> is a bitmap, an <svg> is vector paint. When
// one of these carries information and has no accessible name, the AX-tree
// listing is silent about it and the agent is blind. We surface these as
// "unreadable regions" so the planner can choose to take_screenshot. This is a
// deterministic structural fact ("a nameless graphic is rendered here"), NOT a
// heuristic guess about whether content is "missing" — we report, the model
// decides. nodeName is uppercase for HTML (CANVAS/IMG) and lowercase for the
// XML-cased SVG element, so all comparisons uppercase first.
//
// <iframe> is in REGION_ROLE but NOT OPAQUE_TAGS: it isn't opaque by accessible
// name, it's opaque when its content lives out-of-process (a cross-origin
// OOPIF), so that document never reaches this snapshot and its text/elements
// never reach the brief. collectRegions detects that separately. Only <iframe>
// is handled — legacy <frame>/<frameset> are deliberately out of scope.
const OPAQUE_TAGS = new Set(['CANVAS', 'IMG', 'SVG']);
const REGION_ROLE = { CANVAS: 'canvas', IMG: 'image', SVG: 'graphic', IFRAME: 'iframe' };

// ─── Pure helpers ────────────────────────────────────────────────────────────

function flattenProperties(properties) {
  const result = {};
  if (!properties) return result;
  for (const prop of properties) result[prop.name] = prop.value?.value ?? null;
  return result;
}

// Build the cross-reference tables we use to resolve AX nodes → layout data.
//
// DOMSnapshot returns parallel arrays inside each document, optimized for wire
// size, not for lookup. To find the bbox for an AX node we need three hops:
//
//     backendNodeId ─(byBackendId)→ (doc, nodeIdx)
//                       (nodeIdx) ─(doc.__layoutMap)→ layoutIdx
//                              (layoutIdx) → doc.layout.bounds[layoutIdx]
//
// We precompute both indexes once per snapshot. Stashing `__layoutMap` on the
// document object is a deliberate (cheap) mutation — these objects are local
// to this call and discarded immediately after.
function buildSnapshotMaps(snapshot) {
  const byBackendId = new Map();
  for (const doc of snapshot.documents) {
    const ids = doc.nodes?.backendNodeId ?? [];
    for (let i = 0; i < ids.length; i++) byBackendId.set(ids[i], { doc, nodeIdx: i });
    // Not every node has a layout entry (display:none, detached, etc.). The
    // layoutMap lets getBounds() bail out cleanly with `undefined` instead of
    // scanning the layout arrays linearly.
    const layoutMap = new Map();
    const layoutNodeIndex = doc.layout?.nodeIndex ?? [];
    for (let j = 0; j < layoutNodeIndex.length; j++) layoutMap.set(layoutNodeIndex[j], j);
    doc.__layoutMap = layoutMap;
  }
  // styleIndexMap: STYLE_PROPS[i] → i. Snapshot styles are returned as parallel
  // arrays in the same order we requested them, so this is a simple zip.
  const styleIndexMap = Object.fromEntries(STYLE_PROPS.map((p, i) => [p, i]));
  return { byBackendId, styleIndexMap, strings: snapshot.strings };
}

// DOMSnapshot.captureSnapshot reports layout bounds in DEVICE pixels, but the
// rest of the pipeline (viewport, executor, pageToScreen) works in CSS pixels.
// On a Retina / scaled display (devicePixelRatio > 1) the raw bounds are thus
// dpr× too large and offset dpr× from the origin — boxes inflate and drift
// down-right proportional to position. Divide by the snapshot scale to bring
// bounds back into CSS-pixel space. `maps.scale` defaults to 1 (no-op) on
// ordinary 1:1 displays. See performExtract for how scale is derived.
function getBounds(backendNodeId, maps) {
  const hit = maps.byBackendId.get(backendNodeId);
  if (!hit) return null;
  const layoutIdx = hit.doc.__layoutMap.get(hit.nodeIdx);
  if (layoutIdx === undefined) return null;
  const b = hit.doc.layout?.bounds?.[layoutIdx];
  if (!b) return null;
  const s = maps.scale || 1;
  return { x: b[0] / s, y: b[1] / s, width: b[2] / s, height: b[3] / s };
}

function getComputedStyles(backendNodeId, maps) {
  const hit = maps.byBackendId.get(backendNodeId);
  if (!hit) return null;
  const layoutIdx = hit.doc.__layoutMap.get(hit.nodeIdx);
  if (layoutIdx === undefined) return null;
  const styleValues = hit.doc.layout?.styles?.[layoutIdx];
  if (!styleValues) return null;
  const result = {};
  for (const prop of STYLE_PROPS) {
    const stringIdx = styleValues[maps.styleIndexMap[prop]];
    result[prop] = stringIdx >= 0 ? maps.strings[stringIdx] : null;
  }
  return result;
}

// Device-pixel → CSS-pixel scale, derived WITHOUT injecting JS into the page.
// getLayoutMetrics reports the same viewport/content box in both device pixels
// (layoutViewport / visualViewport / contentSize) and CSS pixels (the css*
// variants), so their ratio is exactly window.devicePixelRatio (display scale ×
// page zoom) — the value we'd otherwise have to Runtime.evaluate. The css* fields
// were added precisely because the originals are device-pixel, so the ratio is
// reliable; we try the most stable pairs first and fall back to 1 (no scaling).
function deriveDeviceScale(m) {
  if (!m) return 1;
  const pairs = [
    [m.contentSize?.width, m.cssContentSize?.width],
    [m.visualViewport?.clientWidth, m.cssVisualViewport?.clientWidth],
    [m.layoutViewport?.clientWidth, m.cssLayoutViewport?.clientWidth],
  ];
  for (const [dev, css] of pairs) {
    if (dev > 0 && css > 0) {
      const s = dev / css;
      if (Number.isFinite(s) && s > 0) return s;
    }
  }
  return 1;
}

function isInViewport(bbox, vp) {
  if (!bbox) return false;
  const x = bbox.x - vp.scrollX;
  const y = bbox.y - vp.scrollY;
  return x + bbox.width > 0 && x < vp.width && y + bbox.height > 0 && y < vp.height;
}

// The perception band — what `inViewportOnly` actually filters on. It is the
// real viewport PLUS one extra viewport-height of look-ahead below the fold.
//
// Why a band and not just the viewport:
//   The fold is an accident of the user's window height, and the loop pays a
//   whole LLM turn whenever a target sits just past it: the model can't see it,
//   emits `scroll`, we re-extract and re-prompt, THEN it acts. Pulling one
//   screen of below-fold content into the brief lets the model find that target
//   on the first turn and skip the scroll-to-look round-trip.
//
// Why the spill is measured in viewport-heights, not in a fixed element count:
//   A scroll reveals exactly one viewport-height of new content, so "one scroll
//   of look-ahead" IS one viewport-height — by definition. An element-count cap
//   can't express that: 60 elements is ~100px on a dense feed (saves no scroll)
//   or thousands of px on a sparse page (overshoots wildly). A height tracks the
//   user's actual window (see `viewport.height`, derived from the layout metrics
//   in performExtract) and self-scales to it.
//
// Why the floor is the true viewport and is NEVER clipped:
//   The viewport is a strict subset of the band (every on-screen element passes
//   the band test too), so this can only ADD below-fold elements — it can never
//   drop something the user can see. The `maxListingLines` cap in reduce.js is
//   the pathological-page seatbelt, and because it truncates in reading order it
//   sheds the lowest (spill) lines first, so visible content stays protected.
//
// Why the spill is downward-only:
//   The loop enters a page at the top and reads/acts top-to-bottom, so the
//   useful look-ahead is what's coming next (below), never what's above. We
//   extend the bottom edge by vp.height and leave the top edge at the viewport.
//
// Note the asymmetry with `isInViewport`: a spilled element is genuinely
// off-screen (`inViewport:false`), so the hit-test can't verify it yet — it
// shows as `unknown` in the debug overlay and the executor still scrolls it in
// (clickablePoint → scrollIntoViewIfNeeded) before clicking. The band governs
// what the model is OFFERED, not what is verified.
function isInPerceptionBand(bbox, vp) {
  if (!bbox) return false;
  const x = bbox.x - vp.scrollX;
  const y = bbox.y - vp.scrollY;
  return x + bbox.width > 0 && x < vp.width && y + bbox.height > 0 && y < vp.height * 2;
}

// Discard elements that have a bbox but aren't actually reachable: hidden via
// CSS, pointer-events:none, or zero-area.
//
// `opacity:0` is the subtle one. It usually means "invisible" — but some sites
// render a native input transparent and draw the visible control with a sibling
// (LinkedIn's search box does this). Keep that escape hatch only for focusable
// input-like roles; an opacity:0 button or generic click target is not a useful
// visual target and should not be offered to the planner.
const TRANSPARENT_INPUT_ROLES = new Set([
  'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
]);

function isLeanVisible(bbox, style, focusable = false, role = null) {
  if (!bbox || bbox.width === 0 || bbox.height === 0) return false;
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style['pointer-events'] === 'none') return false;
  if (style.opacity === '0' && !(focusable && TRANSPARENT_INPUT_ROLES.has(role))) return false;
  return true;
}

// A node with no interactive role and no focusability can still be a click
// target: sites routinely attach onclick to a plain <div>/<span> and signal it
// only with `cursor: pointer` (often plus an aria-label for the name). We treat
// a *named*, non-semantic, pointer-cursored node as interactive.
//
// Name-gated on purpose, for two reasons:
//   1. `cursor` is an INHERITED CSS property — every descendant of a clickable
//      region also computes `cursor:pointer`. Requiring an accessible name keeps
//      us to the labelled targets (icon buttons, aria-label'd divs) instead of
//      dragging in every nested wrapper span.
//   2. A node that has an accessible name is, by that fact, not `ignored` in the
//      AX tree — so the name gate also keeps us clear of ignored nodes for free.
// Clickable containers that carry visible *text* rather than a label are reached
// instead via their @t text node (click accepts @t refs), so they don't need
// this path.
function isCursorClickable(role, name, style) {
  return NON_SEMANTIC_ROLES.has(role)
    && typeof name === 'string' && name.trim() !== ''
    && style?.cursor === 'pointer';
}

function bboxArr(b) {
  return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
}

// AX `invalid` is a TOKEN, not a boolean: "false" (the overwhelmingly common
// case) | "true" | "grammar" | "spelling". The "false" string is itself truthy,
// so a naive `if (props.invalid)` would flag every field — test against it
// explicitly. Any non-false token means the control failed validation, which is
// a direct, reliable signal for form-filling (far better than hoping a nearby
// error string happened to surface as a @t node).
function isInvalid(v) {
  return v != null && v !== false && v !== 'false';
}

// AX `haspopup` is also a token: "false" (no popup) | "true" | "menu" |
// "listbox" | "tree" | "grid" | "dialog". Same "false"-is-a-truthy-string trap
// as isInvalid. Returns the popup kind to surface — so the model knows a click
// opens something, and what — or null when the element opens nothing.
function popupKind(v) {
  if (v == null || v === false || v === 'false') return null;
  return v === true ? 'true' : String(v);
}

// A password field's value must never reach the model. The AX tree usually
// leaves it empty already, but we redact defensively in case a build echoes it.
// We keep a fixed-length placeholder when the field is non-empty so the model
// still knows it was filled (and need not re-type) without seeing the secret —
// and the fixed length never leaks how long the password is.
function safeValue(node, isPassword) {
  const v = node.value?.value;
  if (v == null || v === '') return null;
  return isPassword ? '••••••' : v;
}

// ─── Unreadable-region detection ───────────────────────────────────────────────
//
// Source of truth is the DOMSnapshot, not the AX tree: the very nodes we care
// about (a chart canvas, an alt-less image) are exactly the ones the AX tree
// drops or marks ignored, so we read tags + attributes straight from the DOM.
// Accessible-name semantics are honoured the way the platform defines them —
// no scoring, no thresholds.

// DOMSnapshot stores a node's attributes as a flat [nameIdx, valueIdx, …] array
// of indices into the shared strings table. Decode to a lowercased name→value map.
function parseSnapshotAttrs(attrIdxs, strings) {
  const out = {};
  if (!Array.isArray(attrIdxs)) return out;
  for (let i = 0; i + 1 < attrIdxs.length; i += 2) {
    const name = strings[attrIdxs[i]];
    if (typeof name === 'string') out[name.toLowerCase()] = strings[attrIdxs[i + 1]] ?? '';
  }
  return out;
}

// Does this graphic already carry an accessible name (so its content is not
// "unreadable")? Mirrors how the platform names these elements:
//   - aria-label / aria-labelledby name any element.
//   - <img>: the presence of an `alt` attribute — even alt="" — is the author
//     declaring intent (alt="" means "decorative, skip me"); only a *missing*
//     alt is an unnamed image.
//   - <svg>: a child <title> element is its accessible name.
function hasAccessibleName(tag, attrs, hasTitleChild) {
  if (attrs['aria-label']?.trim()) return true;
  if (attrs['aria-labelledby']?.trim()) return true;
  if (tag === 'IMG' && 'alt' in attrs) return true;
  if (tag === 'SVG' && hasTitleChild) return true;
  return false;
}

// Walk parentIndex up to the document root, reporting whether the node sits
// inside a link or button. Such a graphic is the control's icon — the control
// is the named, actionable thing and is already listed — so we don't surface
// the icon as its own region. parentIndex is per-document; the guard bounds a
// malformed (cyclic) tree.
function hasControlAncestor(idx, parentIndex, tagAt) {
  let p = parentIndex[idx];
  for (let guard = 0; p != null && p >= 0 && guard < 4096; guard++) {
    const t = tagAt(p);
    if (t === 'A' || t === 'BUTTON') return true;
    p = parentIndex[p];
  }
  return false;
}

function isControlTag(tag) {
  return tag === 'A' || tag === 'BUTTON';
}

function cssBackgroundUrl(style) {
  const value = String(style?.['background-image'] || '').trim();
  if (!value || value === 'none') return null;
  const match = value.match(/\burl\((?:"([^"]+)"|'([^']+)'|([^)]*?))\)/i);
  const url = (match?.[1] || match?.[2] || match?.[3] || '').trim();
  return url || null;
}

function hiddenSourceUrl(node) {
  return node?.[REGION_SOURCE_URL_PROP] || null;
}

function setHiddenSourceUrl(node, url) {
  if (!node || !url) return node;
  Object.defineProperty(node, REGION_SOURCE_URL_PROP, {
    value: url,
    enumerable: false,
    configurable: true,
  });
  return node;
}

function resolveResourceUrl(raw, base) {
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw;
  try { return new URL(raw, base || undefined).href; } catch { return null; }
}

function documentUrl(doc, strings) {
  const raw = doc?.documentURL;
  return typeof raw === 'number' ? strings[raw] : raw || null;
}

function hasNonRepeatingBackground(style) {
  const repeat = String(style?.['background-repeat'] || '').toLowerCase();
  if (!repeat) return false;
  return repeat.split(',').every(layer => layer.includes('no-repeat'));
}

function isTinyCssBackground(bbox) {
  return !bbox || bbox.width < MIN_CSS_BACKGROUND_PX || bbox.height < MIN_CSS_BACKGROUND_PX;
}

// backendNodeIds of every <input type="password"> in the snapshot, so the
// element builders can redact their values out of the brief. One cheap pass over
// the same node tables collectRegions walks; reuses parseSnapshotAttrs to read
// the type attribute.
function collectPasswordIds(snapshot) {
  const ids = new Set();
  const strings = snapshot.strings || [];
  for (const doc of snapshot.documents || []) {
    const nodes = doc.nodes;
    if (!nodes) continue;
    const nodeName = nodes.nodeName ?? [];
    const backendIds = nodes.backendNodeId ?? [];
    const attributes = nodes.attributes ?? [];
    for (let i = 0; i < nodeName.length; i++) {
      const tag = (typeof nodeName[i] === 'number' ? (strings[nodeName[i]] || '') : '').toUpperCase();
      if (tag !== 'INPUT') continue;
      const attrs = parseSnapshotAttrs(attributes[i], strings);
      if ((attrs.type || '').toLowerCase() === 'password') ids.add(backendIds[i]);
    }
  }
  return ids;
}

// Scan the DOMSnapshot for content the listing can't speak to: rendered,
// unnamed canvas/img/svg graphics, plus cross-origin iframes whose document
// lives out-of-process. Returns region descriptors { role, bbox, inViewport,
// backendNodeId } in document order. `maps` is the snapshot index built by
// buildSnapshotMaps (also carries the dpr scale).
function collectRegions(snapshot, maps, viewport, opts) {
  const strings = snapshot.strings;
  const regions = [];
  for (const doc of snapshot.documents || []) {
    const nodes = doc.nodes;
    if (!nodes) continue;
    const nodeName = nodes.nodeName ?? [];
    const parentIndex = nodes.parentIndex ?? [];
    const backendIds = nodes.backendNodeId ?? [];
    const attributes = nodes.attributes ?? [];
    const tagAt = (i) => (typeof nodeName[i] === 'number' ? (strings[nodeName[i]] || '') : '').toUpperCase();
    const baseUrl = documentUrl(doc, strings);

    // Pre-pass: which element indices own a <title> child (an svg's name).
    const titleParents = new Set();
    for (let i = 0; i < nodeName.length; i++) {
      if (tagAt(i) === 'TITLE') {
        const p = parentIndex[i];
        if (p != null && p >= 0) titleParents.add(p);
      }
    }

    // contentDocumentIndex (RareIntegerData: a sparse {index, value}) lists the
    // iframe nodes whose content document is embedded in THIS snapshot — i.e.
    // same-process frames, whose text/elements are already extracted. An <iframe>
    // missing from this set is cross-origin (out-of-process, document absent) or
    // unloaded: unreadable from the DOM, so we surface it for a cropped read.
    const embeddedFrames = new Set(nodes.contentDocumentIndex?.index ?? []);

    for (let i = 0; i < nodeName.length; i++) {
      const tag = tagAt(i);
      const isGraphic = OPAQUE_TAGS.has(tag);
      const isFrame = tag === 'IFRAME';   // <iframe> only — legacy <frame> is out of scope
      const style = getComputedStyles(backendIds[i], maps);
      const bgUrl = !isGraphic && !isFrame ? cssBackgroundUrl(style) : null;
      const isCssBackground = !!bgUrl;
      if (!isGraphic && !isFrame && !isCssBackground) continue;

      const attrs = parseSnapshotAttrs(attributes[i], strings);
      if (attrs['aria-hidden'] === 'true') continue;            // author hid it from a11y → decorative

      if (isCssBackground) {
        if (isControlTag(tag) || hasControlAncestor(i, parentIndex, tagAt)) continue;
        if (!hasNonRepeatingBackground(style)) continue;
      } else if (isGraphic) {
        if (hasAccessibleName(tag, attrs, titleParents.has(i))) continue;
      } else if (embeddedFrames.has(i)) {
        continue;   // same-process iframe — its content is already in the brief
      }
      if (hasControlAncestor(i, parentIndex, tagAt)) continue;  // icon/frame inside a link/button

      const bbox = getBounds(backendIds[i], maps);
      if (!bbox || bbox.width === 0 || bbox.height === 0) continue;  // not rendered
      if (isCssBackground && isTinyCssBackground(bbox)) continue;
      const inViewport = isInViewport(bbox, viewport);
      // Filter on the perception band (viewport + one screen of look-ahead);
      // `inViewport` stays the honest on-screen flag. See isInPerceptionBand.
      if (opts.inViewportOnly && !isInPerceptionBand(bbox, viewport)) continue;
      // backendNodeId rides along so the caller can register a lookup entry (used
      // to crop a screenshot to this region); it's stripped before the region
      // lands in the brief, like elements/text never expose their node id.
      const region = { role: isCssBackground ? 'image' : REGION_ROLE[tag], bbox, inViewport, backendNodeId: backendIds[i] };
      const sourceUrl = isCssBackground
        ? resolveResourceUrl(bgUrl, baseUrl)
        : (tag === 'IMG' ? resolveResourceUrl(attrs.currentSrc || attrs.src, baseUrl) : null);
      setHiddenSourceUrl(region, sourceUrl);
      regions.push(region);
    }
  }
  return regions;
}

// ─── Tree mode builders ───────────────────────────────────────────────────────

function buildTreeInteractive(node, props, bbox, inViewport, ref, isPassword) {
  const out = { ref, role: node.role?.value };
  const name = node.name?.value;
  if (name) out.name = name;
  out.bbox = bboxArr(bbox);
  if (inViewport) out.inViewport = true;
  const value = safeValue(node, isPassword);
  if (value != null) out.value = value;
  if (props.url) out.url = props.url;
  if (props.checked != null) out.checked = props.checked;
  if (props.selected != null) out.selected = props.selected;
  if (props.expanded != null) out.expanded = props.expanded;
  const popup = popupKind(props.haspopup);
  if (popup) out.haspopup = popup;
  if (props.required === true) out.required = true;
  if (isInvalid(props.invalid)) out.invalid = true;
  if (props.disabled === true) out.disabled = true;
  if (props.focused === true) out.focused = true;
  return out;
}

function buildTreeText(node, props, bbox, inViewport, ref) {
  const out = { ref, role: node.role?.value, name: node.name.value };
  if (bbox) out.bbox = bboxArr(bbox);
  if (inViewport) out.inViewport = true;
  if (typeof props.level === 'number') out.level = props.level;
  return out;
}

function buildTree(axResult, maps, viewport, opts) {
  const byId = new Map();
  for (const n of axResult.nodes) byId.set(n.nodeId, n);
  const counts = { interactive: 0, text: 0 };
  const lookup = {};

  const interactiveRoles = opts.interactiveRoles
    ? new Set(opts.interactiveRoles)
    : INTERACTIVE_ROLES;
  const containerRoles = opts.containerRoles
    ? new Set(opts.containerRoles)
    : CONTAINER_ROLES;

  function collect(nodeId) {
    const node = byId.get(nodeId);
    if (!node) return [];

    const role = node.role?.value;
    const props = flattenProperties(node.properties);
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const inViewport = isInViewport(bbox, viewport);

    if (!node.ignored) {
      const hasRole = interactiveRoles.has(role);
      const isCustomWidget = props.focusable === true && NON_SEMANTIC_ROLES.has(role);
      const name = node.name?.value;
      // Only generic, named nodes can be cursor-clickable; gate the style lookup
      // on that shape so we don't fetch computed styles for every tree node.
      const maybeCursor = !hasRole && !isCustomWidget && NON_SEMANTIC_ROLES.has(role) && !!name?.trim();
      const style = (hasRole || isCustomWidget || maybeCursor) ? getComputedStyles(id, maps) : null;
      const cursorClickable = maybeCursor && isCursorClickable(role, name, style);

      if (hasRole || isCustomWidget || cursorClickable) {
        if (!isLeanVisible(bbox, style, props.focusable === true, role)) return [];
        // Filter on the perception band; `inViewport` stays the on-screen flag.
        if (opts.inViewportOnly && !isInPerceptionBand(bbox, viewport)) return [];
        counts.interactive++;
        const ref = `@e${counts.interactive}`;
        lookup[ref] = id;
        return [buildTreeInteractive(node, props, bbox, inViewport, ref, maps.passwordIds?.has(id))];
      }

      if (TEXT_ROLES.has(role) && node.name?.value?.trim()) {
        if (!bbox || bbox.width === 0 || bbox.height === 0) return [];
        // Filter on the perception band; `inViewport` stays the on-screen flag.
        if (opts.inViewportOnly && !isInPerceptionBand(bbox, viewport)) return [];
        counts.text++;
        const ref = `@t${counts.text}`;
        lookup[ref] = id;
        return [buildTreeText(node, props, bbox, inViewport, ref)];
      }
    }

    const children = (node.childIds || []).flatMap(collect);

    if (!node.ignored && containerRoles.has(role)) {
      if (children.length === 0) return [];
      if (children.length === 1 && !node.name?.value) return children;
      const out = { role };
      if (node.name?.value) out.name = node.name.value;
      out.children = children;
      return [out];
    }

    return children;
  }

  const roots = axResult.nodes.filter(n => !n.parentId);
  if (!roots.length) return { tree: null, counts, lookup };
  const root = roots.reduce((a, b) =>
    (b.childIds?.length || 0) > (a.childIds?.length || 0) ? b : a
  );
  const result = collect(root.nodeId);
  return { tree: result[0] || null, counts, lookup };
}

// ─── Flat mode builders ───────────────────────────────────────────────────────

function buildLeanElement(node, props, ref, bbox, inViewport, isPassword) {
  const out = { ref, role: node.role?.value ?? null, name: node.name?.value ?? null, bbox, inViewport };
  const value = safeValue(node, isPassword);
  if (value != null) out.value = value;
  if (props.url) out.url = props.url;
  if (props.checked != null) out.checked = props.checked;
  if (props.selected != null) out.selected = props.selected;
  if (props.expanded != null) out.expanded = props.expanded;
  const popup = popupKind(props.haspopup);
  if (popup) out.haspopup = popup;
  if (props.required === true) out.required = true;
  if (isInvalid(props.invalid)) out.invalid = true;
  if (props.disabled === true) out.disabled = true;
  if (props.focused === true) out.focused = true;
  return out;
}

// ─── Main extraction ──────────────────────────────────────────────────────────

async function performExtract(client, opts = {}) {
  const start = Date.now();
  const format = opts.format || (opts.tree ? 'tree' : opts.lean ? 'lean' : 'full');
  if (!['tree', 'lean', 'full'].includes(format)) {
    throw new Error(`unknown extract format "${format}" (expected: tree, lean, full)`);
  }

  // The caller (Session) enables the Accessibility domain once and caches that,
  // so we don't re-enable it on every snapshot here. Direct callers of
  // performExtract must enable it themselves.
  const { Accessibility, DOMSnapshot, Page } = client;

  const [axResult, snapshotResult, layoutMetrics] = await Promise.all([
    Accessibility.getFullAXTree(),
    DOMSnapshot.captureSnapshot({
      computedStyles: STYLE_PROPS,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    }),
    Page.getLayoutMetrics(),
  ]);

  const viewport = {
    width: layoutMetrics.cssLayoutViewport.clientWidth,
    height: layoutMetrics.cssLayoutViewport.clientHeight,
    scrollX: layoutMetrics.cssLayoutViewport.pageX,
    scrollY: layoutMetrics.cssLayoutViewport.pageY,
    // Full scrollable document size — lets the consumer report scroll position
    // and whether more content lies above/below the current view.
    contentWidth: layoutMetrics.cssContentSize?.width ?? null,
    contentHeight: layoutMetrics.cssContentSize?.height ?? null,
  };

  const maps = buildSnapshotMaps(snapshotResult);

  // Snapshot bounds are in DEVICE pixels; normalise to CSS pixels by dividing by
  // the device-pixel ratio (display scale × page zoom). We derive that ratio from
  // getLayoutMetrics — which already reports the same boxes in both unit systems —
  // instead of reading window.devicePixelRatio via Runtime.evaluate, so the
  // perception pass injects NO script into the page (the no-footprint contract).
  // Defaults to 1 on a 1:1 display; dump it with BROWSER_AGENT_DEBUG_COORDS=1 to confirm
  // on a Retina/scaled display.
  maps.scale = deriveDeviceScale(layoutMetrics);
  // backendNodeIds of password inputs, so the element builders can redact their
  // values out of the brief — a secret must never reach the model.
  maps.passwordIds = collectPasswordIds(snapshotResult);
  if (process.env.BROWSER_AGENT_DEBUG_COORDS) console.error(`[extract] bounds scale = ${maps.scale}`);

  const base = {
    schemaVersion: '2.0',
    url: null,    // populated by Session from target info
    title: null,
    timestamp: new Date().toISOString(),
    viewport,
  };

  if (format === 'tree') {
    const { tree, counts, lookup } = buildTree(axResult, maps, viewport, opts);
    return {
      ...base,
      tree,
      lookup,
      stats: {
        totalAXNodes: axResult.nodes.length,
        interactiveReturned: counts.interactive,
        textReturned: counts.text,
        elapsedMs: Date.now() - start,
      },
    };
  }

  // full / lean flat mode
  const interactiveRoles = opts.interactiveRoles ? new Set(opts.interactiveRoles) : INTERACTIVE_ROLES;

  const interactiveNodes = [];
  const textNodes = [];
  for (const n of axResult.nodes) {
    if (n.ignored) continue;
    const role = n.role?.value;
    const props = flattenProperties(n.properties);
    const name = n.name?.value;
    if (interactiveRoles.has(role) || (props.focusable === true && NON_SEMANTIC_ROLES.has(role))) {
      interactiveNodes.push({ node: n, props, source: interactiveRoles.has(role) ? 'role' : 'focusable' });
    } else if (NON_SEMANTIC_ROLES.has(role) && name?.trim()
               && isCursorClickable(role, name, getComputedStyles(n.backendDOMNodeId, maps))) {
      interactiveNodes.push({ node: n, props, source: 'cursor' });
    }
    if (TEXT_ROLES.has(role) && n.name?.value?.trim()) {
      textNodes.push({ node: n, props });
    }
  }

  const stats = {
    totalAXNodes: axResult.nodes.length,
    interactiveFound: interactiveNodes.length,
    textFound: textNodes.length,
    withBounds: 0,
    inViewport: 0,
    returned: 0,
  };

  const lookup = {};
  const elements = [];
  for (const { node, props, source } of interactiveNodes) {
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const style = getComputedStyles(id, maps);
    const inViewport = isInViewport(bbox, viewport);
    if (bbox) stats.withBounds++;
    if (inViewport) stats.inViewport++;
    // Filter on the perception band (viewport + one screen of look-ahead) so the
    // model can act on a just-below-the-fold target without a scroll-to-look
    // turn; `inViewport` remains the honest on-screen flag. See isInPerceptionBand.
    if (opts.inViewportOnly && !isInPerceptionBand(bbox, viewport)) continue;
    if (format === 'lean' && !isLeanVisible(bbox, style, props.focusable === true, node.role?.value)) continue;

    const ref = `@e${elements.length + 1}`;
    lookup[ref] = id;

    if (format === 'lean') {
      elements.push(buildLeanElement(node, props, ref, bbox, inViewport, maps.passwordIds?.has(id)));
    } else {
      elements.push({
        ref,
        role: node.role?.value ?? null,
        name: node.name?.value ?? null,
        source,
        focusable: props.focusable ?? null,
        focused: props.focused ?? null,
        expanded: props.expanded ?? null,
        checked: props.checked ?? null,
        selected: props.selected ?? null,
        haspopup: props.haspopup ?? null,
        required: props.required ?? null,
        invalid: props.invalid ?? null,
        disabled: props.disabled ?? null,
        url: props.url ?? null,
        bbox,
        inViewport,
        computedStyle: style,
      });
    }
  }
  stats.returned = elements.length;

  const text = [];
  for (const { node, props } of textNodes) {
    const id = node.backendDOMNodeId;
    const bbox = getBounds(id, maps);
    const inViewport = isInViewport(bbox, viewport);
    // Filter on the perception band; `inViewport` stays the on-screen flag.
    if (opts.inViewportOnly && !isInPerceptionBand(bbox, viewport)) continue;
    if (format === 'lean' && (!bbox || bbox.width === 0 || bbox.height === 0)) continue;

    const ref = `@t${text.length + 1}`;
    lookup[ref] = id;

    if (format === 'lean') {
      const t = { ref, role: node.role?.value ?? null, name: node.name.value, bbox, inViewport };
      if (typeof props.level === 'number') t.level = props.level;
      text.push(t);
    } else {
      text.push({
        ref,
        role: node.role?.value ?? null,
        name: node.name.value,
        level: typeof props.level === 'number' ? props.level : null,
        bbox,
        inViewport,
      });
    }
  }

  // Rendered, unnamed graphics the listing above can't speak to (charts, maps,
  // scanned text, CAPTCHAs). Each gets an @r ref + lookup entry so the model can
  // take_screenshot(@rN) and have the capture cropped to the graphic's bbox.
  // Only take_screenshot accepts an @r ref — click/type/select_text reject it.
  const regions = collectRegions(snapshotResult, maps, viewport, opts);
  for (let i = 0; i < regions.length; i++) {
    const ref = `@r${i + 1}`;
    lookup[ref] = regions[i].backendNodeId;
    const region = { ref, role: regions[i].role, bbox: regions[i].bbox, inViewport: regions[i].inViewport };
    setHiddenSourceUrl(region, hiddenSourceUrl(regions[i]));
    regions[i] = region;
  }
  stats.regionsReturned = regions.length;

  stats.elapsedMs = Date.now() - start;
  return { ...base, elements, text, regions, lookup, stats };
}

module.exports = {
  performExtract,
  // exported for testing
  flattenProperties, isInViewport, isInPerceptionBand, isLeanVisible, isCursorClickable, isInvalid, popupKind, safeValue, bboxArr,
  collectRegions, collectPasswordIds, parseSnapshotAttrs, hasAccessibleName, buildSnapshotMaps,
  hiddenSourceUrl, setHiddenSourceUrl,
  INTERACTIVE_ROLES, TEXT_ROLES, CONTAINER_ROLES, NON_SEMANTIC_ROLES, STYLE_PROPS, TRANSPARENT_INPUT_ROLES,
  OPAQUE_TAGS, REGION_ROLE,
};
