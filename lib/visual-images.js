'use strict';

const MAX_VISUAL_IMAGES = 40;
const DEFAULT_TIMEOUT_MS = 150;

function readSparseString(strings, rare, index) {
  const offset = rare?.index?.indexOf(index);
  return offset == null || offset < 0 ? '' : strings[rare.value[offset]];
}

function parseAttrs(attrIdxs, strings) {
  const out = {};
  if (!Array.isArray(attrIdxs)) return out;
  for (let i = 0; i + 1 < attrIdxs.length; i += 2) {
    const name = strings[attrIdxs[i]];
    if (typeof name === 'string') out[name.toLowerCase()] = strings[attrIdxs[i + 1]] ?? '';
  }
  return out;
}

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
  for (const [prop, index] of Object.entries(maps.styleIndexMap || {})) {
    const stringIdx = styleValues[index];
    result[prop] = stringIdx >= 0 ? maps.strings[stringIdx] : null;
  }
  return result;
}

function isLeanVisible(bbox, style) {
  if (!bbox || bbox.width === 0 || bbox.height === 0) return false;
  if (!style) return true;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style['pointer-events'] === 'none') return false;
  if (style.opacity === '0') return false;
  return true;
}

function isInViewport(bbox, vp) {
  if (!bbox) return false;
  const x = bbox.x - vp.scrollX;
  const y = bbox.y - vp.scrollY;
  return x + bbox.width > 0 && x < vp.width && y + bbox.height > 0 && y < vp.height;
}

function isInPerceptionBand(bbox, vp) {
  if (!bbox) return false;
  const x = bbox.x - vp.scrollX;
  const y = bbox.y - vp.scrollY;
  return x + bbox.width > 0 && x < vp.width && y + bbox.height > 0 && y < vp.height * 2;
}

function cssBackgroundUrl(style) {
  const value = String(style?.['background-image'] || '').trim();
  if (!value || value === 'none') return null;
  const match = value.match(/\burl\((?:"([^"]+)"|'([^']+)'|([^)]*?))\)/i);
  const url = (match?.[1] || match?.[2] || match?.[3] || '').trim();
  return url || null;
}

function documentUrl(doc, strings) {
  const raw = doc?.documentURL;
  return typeof raw === 'number' ? strings[raw] : raw || null;
}

function resolveResourceUrl(raw, base) {
  if (!raw) return null;
  if (/^data:/i.test(raw)) return raw;
  try { return new URL(raw, base || undefined).href; } catch { return null; }
}

function urlsFrom(value = '') {
  return [...String(value).matchAll(/(?:https?:\/\/|data:image\/)[^\s'",)]+/g)].map(match => match[0]);
}

function imageishAttr(name, value) {
  return /src|srcset|image|poster|background|style|content|href/i.test(name) || /url\(/i.test(value);
}

function hasImageExtension(url) {
  return /\.(jpe?g|png|gif|webp|svg|avif|bmp)(?:[?#]|$)/i.test(url) || /^data:image\//i.test(url);
}

function imageishUrl(url) {
  return hasImageExtension(url)
    || /\/(image|images|img|photo|photos|media|avatar|logo|icon|thumbnail|thumb|poster|background)([/?._-]|$)/i.test(url);
}

function imageishNode(tag, attrs) {
  return tag === 'IMG'
    || tag === 'IMAGE'
    || tag === 'SOURCE'
    || tag === 'PICTURE'
    || (tag === 'LINK' && (attrs.as === 'image' || /icon|image/i.test(attrs.rel || '')))
    || (tag === 'META' && /image/i.test(`${attrs.name || ''} ${attrs.property || ''}`))
    || /^image\//i.test(attrs.type || '');
}

function visualImageHints(attrs) {
  const out = {};
  for (const [from, to] of [
    ['alt', 'alt'],
    ['title', 'title'],
    ['id', 'id'],
    ['class', 'class'],
    ['role', 'role'],
    ['aria-label', 'ariaLabel'],
    ['name', 'name'],
    ['property', 'property'],
  ]) {
    if (attrs[from]) out[to] = attrs[from];
  }
  return out;
}

function visualImageScore(image) {
  const area = (image.width || 0) * (image.height || 0);
  const text = JSON.stringify(image).toLowerCase();
  let score = 0;
  if ((image.width || 0) >= 100 && (image.height || 0) >= 100) score += 40;
  else if ((image.width || 0) >= 50 && (image.height || 0) >= 50) score += 15;
  if (area >= 120000) score += 25;
  else if (area >= 40000) score += 18;
  else if (area >= 10000) score += 10;
  if (image.visible) score += 15;
  if (image.kind === 'currentSourceURL') score += 15;
  if (image.kind === 'domAttribute' && /^(IMG|SOURCE|IMAGE)$/.test(image.nodeName || '')) score += 20;
  if (image.kind === 'computedStyle') score -= 10;
  if (image.nodeName === 'LINK') score -= 25;
  if (/icon|sprite|chevron|caret|badge|emoji|button|favicon|placeholder/.test(text)) score -= 30;
  if (/logo/.test(text)) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function collectVisualImages(snapshot, maps, viewport, opts = {}) {
  const strings = snapshot.strings || [];
  const byUrl = new Map();
  const deadline = Date.now() + (Number.isFinite(opts.visualImageTimeoutMs) ? opts.visualImageTimeoutMs : DEFAULT_TIMEOUT_MS);
  const timedOut = () => Date.now() > deadline;
  const add = (url, image) => {
    if (timedOut()) return;
    const sourceUrl = resolveResourceUrl(url, image.documentURL);
    if (!sourceUrl || (!imageishUrl(sourceUrl) && !imageishNode(image.nodeName, image.hints || {}))) return;
    const next = { ...image, sourceUrl };
    next.score = visualImageScore(next);
    const existing = byUrl.get(sourceUrl);
    if (!existing || next.score > existing.score) byUrl.set(sourceUrl, next);
  };

  for (const doc of snapshot.documents || []) {
    if (timedOut()) break;
    const nodes = doc.nodes;
    if (!nodes) continue;
    const nodeName = nodes.nodeName ?? [];
    const backendIds = nodes.backendNodeId ?? [];
    const attributes = nodes.attributes ?? [];
    const baseUrl = documentUrl(doc, strings);

    for (let i = 0; i < nodeName.length; i++) {
      if (timedOut()) break;
      const tag = (typeof nodeName[i] === 'number' ? (strings[nodeName[i]] || '') : '').toUpperCase();
      const attrs = parseAttrs(attributes[i], strings);
      const bbox = getBounds(backendIds[i], maps);
      const style = getComputedStyles(backendIds[i], maps);
      const visible = isLeanVisible(bbox, style);
      const inViewport = isInViewport(bbox, viewport);
      if (opts.inViewportOnly && bbox && !isInPerceptionBand(bbox, viewport)) continue;
      const baseImage = {
        kind: 'domAttribute',
        nodeName: tag,
        backendNodeId: backendIds[i],
        documentURL: baseUrl,
        width: bbox?.width ? Math.round(bbox.width) : undefined,
        height: bbox?.height ? Math.round(bbox.height) : undefined,
        visible,
        inViewport,
        hints: visualImageHints(attrs),
      };
      const nodeIsImage = imageishNode(tag, attrs);
      for (const [attribute, value] of Object.entries(attrs)) {
        if (timedOut()) break;
        if (!nodeIsImage && !imageishAttr(attribute, value)) continue;
        for (const url of urlsFrom(value)) add(url, { ...baseImage, attribute });
      }
      const currentSourceURL = readSparseString(strings, nodes.currentSourceURL, i);
      if (currentSourceURL) add(currentSourceURL, { ...baseImage, kind: 'currentSourceURL' });
      const bgUrl = cssBackgroundUrl(style);
      if (bgUrl) add(bgUrl, { ...baseImage, kind: 'computedStyle', attribute: 'background-image' });
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score || a.sourceUrl.localeCompare(b.sourceUrl))
    .slice(0, opts.maxVisualImages || MAX_VISUAL_IMAGES);
}

module.exports = { collectVisualImages };
