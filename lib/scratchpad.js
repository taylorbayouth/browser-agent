'use strict';

// Per-run scratchpad. Saved evidence lives in one structured manifest:
//
//   runs/<run-id>/saved-manifest.json
//   runs/<run-id>/assets/
//
// Text evidence is stored directly in the manifest. Binary evidence is promoted
// to assets/ and referenced by file name in the manifest.

const fs = require('fs');
const path = require('path');
const { cleanWebText } = require('./text');
const { markdownToHtmlDocument } = require('./markdown');
const { resizeImageBuffer } = require('./image');

const MANIFEST_VERSION = 1;
const RESIZABLE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

function filenameStemFromHint(hint, maxLength = 80) {
  const stem = String(hint || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return stem || null;
}

function uniqueAssetName(assetsDir, name, counter) {
  if (!fs.existsSync(path.join(assetsDir, name))) return name;
  const parsed = path.parse(name);
  let n = counter;
  do {
    name = `${parsed.name}-${n++}${parsed.ext}`;
  } while (fs.existsSync(path.join(assetsDir, name)));
  return name;
}

function screenshotTitle({ title, hint, count } = {}) {
  const hinted = cleanWebText(hint || '').replace(/\s+/g, ' ').trim();
  if (hinted) return /\bscreenshot$/i.test(hinted) ? hinted : `${hinted} screenshot`;
  const titled = cleanWebText(title || '').replace(/\s+/g, ' ').trim();
  return titled || `Image ${count}`;
}

function compactMetadata(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  const text = String(value).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { note: text };
}

function pruneEmpty(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

function createScratchpad({ enabled = true, dir = path.resolve(process.cwd(), 'runs'), runId } = {}) {
  if (!enabled) {
    return {
      saveRecord() { return null; }, saveText() { return null; }, saveImage() { return null; },
      saveAsset() { return null; }, readManifest() { return ''; }, writeReport() { return null; },
      dir: null, reportPath: null, reportHtmlPath: null, manifestPath: null, assetsDir: null,
    };
  }

  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);
  const runDir = path.join(dir, runId || 'run');
  const manifestPath = path.join(runDir, 'saved-manifest.json');
  const reportPath = path.join(runDir, 'report.md');
  const reportHtmlPath = path.join(runDir, 'report.html');
  const assetsDir = path.join(runDir, 'assets');

  let saveCount = 0;
  let textCount = 0;
  let imageCount = 0;
  let assetCount = 0;
  let recordCount = 0;
  const manifest = { version: MANIFEST_VERSION, asset_dir: 'assets', records: [], unassigned: [] };

  fs.mkdirSync(runDir, { recursive: true });

  function writeManifest() {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
  }

  function appendManifestSave({ kind, fileName, reason, metadata, content } = {}) {
    const meta = pruneEmpty(compactMetadata(metadata));
    const item = pruneEmpty({
      kind,
      file_name: fileName || undefined,
      save_reason: reason ? String(reason).trim() : undefined,
      content: content != null ? String(content) : undefined,
    });
    if (Object.keys(meta).length) item.metadata = meta;
    manifest.unassigned.push(item);
    writeManifest();
  }

  function saveRecord({ metadata, title, url, reason } = {}) {
    recordCount++;
    const meta = pruneEmpty({
      ...compactMetadata(metadata),
      title,
      url,
      save_reason: reason ? String(reason).trim() : undefined,
    });
    const record = { saves: manifest.unassigned.splice(0) };
    if (Object.keys(meta).length) record.metadata = meta;
    manifest.records.push(record);
    writeManifest();
    return { path: manifestPath, name: 'saved-manifest.json', count: recordCount };
  }

  function saveText({ content, summary, title, url, reason, metadata } = {}) {
    if (content == null) return null;
    saveCount++;
    textCount++;
    const text = cleanWebText(String(content));
    appendManifestSave({
      kind: 'text',
      reason,
      content: text,
      metadata: {
        ...compactMetadata(metadata),
        url,
        title: title || undefined,
        summary: summary || undefined,
      },
    });
    return { path: manifestPath, name: 'saved-manifest.json', count: textCount };
  }

  async function saveImage({ base64, title, url, description, hint, id, ext = 'png', reason, metadata, resize } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    saveCount++;
    imageCount++;
    const hintStem = filenameStemFromHint(hint);
    const stem = hintStem ? `${hintStem}-screenshot-${id || imageCount}` : `screenshot-${imageCount}`;
    const name = uniqueAssetName(assetsDir, `${stem}.${ext}`, imageCount);
    const imgPath = path.join(assetsDir, name);
    let buffer = Buffer.from(base64, 'base64');
    let resizeMeta = null;
    if (RESIZABLE_IMAGE_EXTS.has(String(ext).toLowerCase())) {
      try {
        const resized = await resizeImageBuffer(buffer, { targetAverageSide: resize?.targetAverageSidePx, ext });
        buffer = resized.buffer;
        resizeMeta = resized.metadata?.resized ? {
          original_width: resized.metadata.originalWidth,
          original_height: resized.metadata.originalHeight,
          width: resized.metadata.width,
          height: resized.metadata.height,
          target_average_side_px: resized.metadata.targetAverageSide,
        } : null;
      } catch {}
    }
    fs.writeFileSync(imgPath, buffer);
    const displayTitle = screenshotTitle({ title, hint, count: imageCount });
    appendManifestSave({
      kind: 'image',
      fileName: name,
      reason,
      metadata: {
        ...compactMetadata(metadata),
        ...compactMetadata(resizeMeta),
        url,
        title: displayTitle,
        description: description || undefined,
      },
    });
    return { path: imgPath, name, count: imageCount };
  }

  function saveAsset({ base64, filename, summary, url, hint, id, reason, metadata } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    saveCount++;
    assetCount++;
    const fallback = String(filename || '').split(/[?#]/)[0].split('/').pop().replace(/[^\w.\-]/g, '_');
    const parsed = path.parse(fallback);
    const stem = filenameStemFromHint(hint) || filenameStemFromHint(parsed.name) || 'download';
    let name = `${stem}-file-${id || assetCount}${parsed.ext}`;
    name = uniqueAssetName(assetsDir, name, assetCount);
    const filePath = path.join(assetsDir, name);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    appendManifestSave({
      kind: 'file',
      fileName: name,
      reason,
      metadata: {
        ...compactMetadata(metadata),
        source_url: url,
        summary: summary || undefined,
      },
    });
    return { path: filePath, name, count: assetCount };
  }

  function readManifest() {
    try { return fs.readFileSync(manifestPath, 'utf8'); } catch { return ''; }
  }

  function writeReport(markdown, { title = 'Report', layout, extraCss, className } = {}) {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(reportPath, String(markdown ?? ''));
    fs.writeFileSync(reportHtmlPath, markdownToHtmlDocument(markdown, { title, layout, extraCss, className }));
    return reportPath;
  }

  return {
    get saveCount() { return saveCount; },
    get textCount() { return textCount; },
    get imageCount() { return imageCount; },
    get recordCount() { return recordCount; },
    dir: runDir,
    manifestPath,
    reportPath,
    reportHtmlPath,
    assetsDir,
    saveRecord,
    saveText,
    saveImage,
    saveAsset,
    readManifest,
    writeReport,
  };
}

module.exports = { createScratchpad, filenameStemFromHint, MANIFEST_VERSION };
