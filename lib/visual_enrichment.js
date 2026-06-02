'use strict';

const { captureImage } = require('./screenshot');
const vision = require('./vision');
const { hiddenSourceUrl, setHiddenSourceUrl } = require('./extract');

const VISUAL_CACHE_PROP = '__browserAgentVisualCache';
const analysisCache = new Map();
const MAX_ANALYSIS_CACHE = 256;
const DEFAULT_MAX_REGIONS = 8;

function toBox(bbox) {
  if (!bbox) return null;
  return Array.isArray(bbox)
    ? { x: bbox[0], y: bbox[1], width: bbox[2], height: bbox[3] }
    : bbox;
}

function areaOf(node) {
  const b = toBox(node?.bbox);
  return b ? Math.max(0, b.width) * Math.max(0, b.height) : 0;
}

function regionKey(region) {
  const b = toBox(region?.bbox);
  const box = b
    ? [b.x, b.y, b.width, b.height].map(n => Math.round(n)).join(',')
    : 'no-box';
  return `${region?.ref || ''}|${region?.role || ''}|${box}`;
}

function setCachedAnalysis(key, value) {
  if (analysisCache.size >= MAX_ANALYSIS_CACHE) {
    analysisCache.delete(analysisCache.keys().next().value);
  }
  analysisCache.set(key, value);
}

function visualCacheFor(brief) {
  if (!brief) return null;
  if (!brief[VISUAL_CACHE_PROP]) {
    Object.defineProperty(brief, VISUAL_CACHE_PROP, {
      value: new Map(),
      enumerable: false,
      configurable: true,
    });
  }
  return brief[VISUAL_CACHE_PROP];
}

function getCachedVisualImage(brief, ref) {
  return brief?.[VISUAL_CACHE_PROP]?.get(ref) || null;
}

function prioritizedRegionRefs(regions, maxRegions) {
  return new Set(
    regions
      .map((region, index) => ({ region, index, area: areaOf(region) }))
      .sort((a, b) => (b.area - a.area) || (a.index - b.index))
      .slice(0, maxRegions)
      .map(item => item.region.ref),
  );
}

function nextRef(prefix, nodes) {
  let max = 0;
  for (const node of nodes || []) {
    const n = Number(String(node.ref || '').match(new RegExp(`^@${prefix}(\\d+)$`))?.[1]);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return () => `@${prefix}${++max}`;
}

async function classifyRegion({ session, brief, region, rawHash, signal }) {
  const captured = await captureImage({ session, brief, ref: region.ref });
  const key = `${rawHash || 'unknown'}|${regionKey(region)}`;
  let classification = analysisCache.get(key);
  if (!classification) {
    classification = await vision.classifyVisualEvidence({
      imageBase64: captured.image,
      mimeType: captured.mimeType,
      signal,
    });
    setCachedAnalysis(key, classification);
  }
  return { captured, classification };
}

async function enrichVisualEvidence({ session, brief, config = {}, rawHash, signal } = {}) {
  if (!brief || config.enabled === false) return brief;
  if (!session?.client?.Page?.captureScreenshot) return brief;

  const regions = brief.regions || [];
  if (!regions.length) return brief;

  const maxRegions = Math.max(0, Math.floor(Number.isFinite(config.maxRegions) ? config.maxRegions : DEFAULT_MAX_REGIONS));
  if (!maxRegions) return brief;

  const selected = prioritizedRegionRefs(regions, maxRegions);
  const keptRegions = [];
  const text = [...(brief.text || [])];
  const visuals = [...(brief.visuals || [])];
  const lookup = { ...(brief.lookup || {}) };
  const nextTextRef = nextRef('t', text);
  const nextVisualRef = nextRef('v', visuals);
  const visualCache = visualCacheFor(brief);

  let analyzed = 0;
  let omitted = 0;

  for (const region of regions) {
    if (!selected.has(region.ref)) {
      keptRegions.push(region);
      continue;
    }

    let result;
    try {
      result = await classifyRegion({ session, brief, region, rawHash, signal });
      analyzed++;
    } catch {
      // A vision/capture failure should not hide a region the old planner could
      // still inspect manually with take_screenshot, so keep @r as a fallback.
      keptRegions.push(region);
      continue;
    }

    const backendNodeId = lookup[region.ref];
    delete lookup[region.ref];

    if (result.classification.kind === 'visual') {
      const ref = nextVisualRef();
      const visual = setHiddenSourceUrl({
        ref,
        role: region.role,
        description: result.classification.description,
        sourceRef: region.ref,
        bbox: region.bbox,
        inViewport: region.inViewport,
      }, hiddenSourceUrl(region));
      visuals.push(visual);
      if (backendNodeId != null) lookup[ref] = backendNodeId;
      visualCache.set(ref, {
        image: result.captured.image,
        mimeType: result.captured.mimeType,
        ext: result.captured.ext,
        description: result.classification.description,
        sourceRef: region.ref,
        sourceUrl: hiddenSourceUrl(region),
      });
    } else if (result.classification.kind === 'text') {
      const ref = nextTextRef();
      text.push({
        ref,
        role: 'StaticText',
        name: result.classification.text,
        bbox: region.bbox,
        inViewport: region.inViewport,
        derived: 'vision',
        sourceRef: region.ref,
      });
      if (backendNodeId != null) lookup[ref] = backendNodeId;
    } else {
      omitted++;
    }
  }

  brief.text = text;
  brief.visuals = visuals;
  brief.regions = keptRegions;
  brief.lookup = lookup;
  brief.stats = {
    ...(brief.stats || {}),
    regionsAnalyzed: ((brief.stats || {}).regionsAnalyzed || 0) + analyzed,
    regionsOmitted: ((brief.stats || {}).regionsOmitted || 0) + omitted,
    visualsReturned: visuals.length,
  };
  return brief;
}

function clearVisualEvidenceCache() {
  analysisCache.clear();
}

module.exports = {
  enrichVisualEvidence,
  getCachedVisualImage,
  clearVisualEvidenceCache,
};
