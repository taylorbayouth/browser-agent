'use strict';

const vision = require('./vision');
const { capture } = require('./screenshot');
const { setVisualEvidence } = require('./visual-cache');

const DEFAULT_MAX_REGIONS = 8;
const MAX_CACHE_ENTRIES = 64;

function bboxKey(b) {
  if (!b) return '';
  const box = Array.isArray(b) ? { x: b[0], y: b[1], width: b[2], height: b[3] } : b;
  return [box.x, box.y, box.width, box.height].map(n => Math.round(Number(n) || 0)).join(',');
}

function regionKey(brief, region) {
  return [
    brief?.url || '',
    region.role || '',
    region.sourceUrl || '',
    region.label || '',
    region.named ? 'named' : 'unnamed',
    bboxKey(region.bbox),
  ].join('|');
}

function firstWords(text, maxWords = 10) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
}

function nextTextRef(brief) {
  let max = 0;
  for (const t of brief.text || []) {
    const n = /^@t(\d+)$/.exec(t.ref || '')?.[1];
    if (n) max = Math.max(max, Number(n));
  }
  return `@t${max + 1}`;
}

function scoreRegion(region) {
  const b = Array.isArray(region.bbox)
    ? { width: region.bbox[2], height: region.bbox[3] }
    : (region.bbox || {});
  const area = Math.max(0, Number(b.width) || 0) * Math.max(0, Number(b.height) || 0);
  const priority = region.named ? 1 : 0;
  return { priority, area };
}

function pickRegions(regions, maxRegions) {
  return [...(regions || [])]
    .map((region, index) => ({ region, index, ...scoreRegion(region) }))
    .sort((a, b) => (a.priority - b.priority) || (b.area - a.area) || (a.index - b.index))
    .slice(0, maxRegions)
    .map(x => x.region);
}

function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

function injectText(brief, region, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const ref = nextTextRef(brief);
  const node = {
    ref,
    role: 'vision-text',
    name: trimmed,
    bbox: region.bbox,
    inViewport: region.inViewport,
    derived: 'vision',
    sourceRef: region.ref,
  };
  brief.text = [...(brief.text || []), node];
  if (brief.lookup && region.ref in brief.lookup) brief.lookup[ref] = brief.lookup[region.ref];
}

function applyAnalysis(brief, region, captured, analysis) {
  const description = String(analysis.description || '').trim();
  const text = String(analysis.text || '').trim();
  const evidence = {
    imageBase64: captured.image,
    mimeType: captured.mimeType,
    ext: captured.ext,
    cropped: captured.cropped,
    description,
    text,
    omit: analysis.omit === true,
    referenceImage: analysis.referenceImage === true,
    sourceUrl: region.sourceUrl || null,
    summary: firstWords(description || text),
  };
  setVisualEvidence(region, evidence);
  if (description) region.description = description;
  if (analysis.referenceImage === true) region.referenceImage = true;
  if (text) injectText(brief, region, text);
  return evidence;
}

function createVisualEvidence(opts = {}) {
  const enabled = opts.enabled !== false;
  const maxRegions = Number.isFinite(opts.maxRegions) ? Math.max(0, Math.floor(opts.maxRegions)) : DEFAULT_MAX_REGIONS;
  const cache = new Map();

  async function enrich({ session, brief, signal } = {}) {
    if (!enabled || !maxRegions || !session?.client || !brief?.regions?.length) return brief;

    const selected = new Set(pickRegions(brief.regions, maxRegions));
    const omittedRefs = new Set();

    for (const region of brief.regions) {
      if (!selected.has(region)) continue;
      const key = regionKey(brief, region);
      let cached = cache.get(key);
      try {
        if (!cached) {
          const captured = await capture({ session, ref: region.ref, brief, signal });
          const analysis = await vision.analyzeVisualEvidence({
            imageBase64: captured.image,
            mimeType: captured.mimeType,
            signal,
          });
          cached = { captured, analysis };
          remember(cache, key, cached);
        }
        const evidence = applyAnalysis(brief, region, cached.captured, cached.analysis);
        if (evidence.omit) omittedRefs.add(region.ref);
      } catch {
        // Visual enrichment is opportunistic. Leave the @v line in place so the
        // planner can still inspect or save it explicitly.
      }
    }

    if (omittedRefs.size) {
      brief.regions = brief.regions.filter(r => !omittedRefs.has(r.ref));
      if (brief.lookup) {
        for (const ref of omittedRefs) delete brief.lookup[ref];
      }
    }
    return brief;
  }

  return { enrich };
}

module.exports = {
  createVisualEvidence,
  pickRegions,
  regionKey,
};
