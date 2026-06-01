'use strict';

// Per-run scratchpad. The model saves things it gathers (a text selection, a
// block of notes it wrote, a captured image) into one run folder:
//
//   runs/<run-id>/saved.md        (raw in-run staging rollup)
//   runs/<run-id>/saved-index.md  (compact index, one row per save)
//   runs/<run-id>/assets/         (screenshots and downloaded files)
//
// The bulk content lives on disk, never in the model's working context - the
// loop only re-injects a short summary. At the end of a run the report pass
// reads either saved.md or saved-index.md, depending on the token budget.

const fs = require('fs');
const path = require('path');
const { cleanWebText } = require('./text');
const { markdownToHtmlDocument } = require('./markdown');

const INDEX_SUMMARY_WORDS = 30;

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

function markdownLabel(text, fallback) {
  return String(text || fallback || 'asset')
    .split('\n')[0]
    .replace(/[\[\]]/g, '')
    .trim()
    .slice(0, 120) || fallback || 'asset';
}

function screenshotTitle({ title, hint, count } = {}) {
  const hinted = cleanWebText(hint || '').replace(/\s+/g, ' ').trim();
  if (hinted) return /\bscreenshot$/i.test(hinted) ? hinted : `${hinted} screenshot`;
  const titled = cleanWebText(title || '').replace(/\s+/g, ' ').trim();
  return titled || `Image ${count}`;
}

function compactWords(text, maxWords = INDEX_SUMMARY_WORDS) {
  return cleanWebText(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, maxWords)
    .join(' ');
}

function createScratchpad({ enabled = true, dir = path.resolve(process.cwd(), 'runs'), runId } = {}) {
  if (!enabled) {
    return {
      saveText() { return null; }, saveImage() { return null; },
      saveAsset() { return null; }, readMarkdown() { return ''; }, readIndex() { return ''; },
      writeReport() { return null; }, dir: null, reportPath: null, reportHtmlPath: null, indexPath: null, assetsDir: null,
    };
  }
  if (!path.isAbsolute(dir)) dir = path.resolve(process.cwd(), dir);
  const runDir = path.join(dir, runId || 'run');
  const savedPath = path.join(runDir, 'saved.md');
  const indexPath = path.join(runDir, 'saved-index.md');
  const reportPath = path.join(runDir, 'report.md');
  const reportHtmlPath = path.join(runDir, 'report.html');
  const assetsDir = path.join(runDir, 'assets');
  let saveCount = 0;
  let textCount = 0;
  let imageCount = 0;
  let assetCount = 0;

  fs.mkdirSync(runDir, { recursive: true });

  function appendIndex({ type, title, url, source, reason, assetLabel, assetPath, summary } = {}) {
    const heading = compactWords(title || summary || type || 'saved item', 10) || 'Saved item';
    const compactSummary = compactWords(summary || title || '', INDEX_SUMMARY_WORDS);
    const block = [
      `### ${heading}`,
      type ? `- Type: ${type}` : null,
      url ? `- URL: ${url}` : null,
      source ? `- Source: ${source}` : null,
      reason ? `- Reason: ${String(reason).trim()}` : null,
      assetPath ? `- ${assetLabel || 'Asset'}: [${assetPath}](${assetPath})` : null,
      compactSummary ? `- Summary: ${compactSummary}` : null,
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(indexPath, block + '\n');
  }

  // Save model-gathered text to saved.md, headed by the model's summary. Full
  // text stays on disk; only the summary re-enters the loop.
  function saveText({ content, summary, title, url, reason } = {}) {
    if (content == null) return null;
    saveCount++;
    textCount++;
    const recordId = `save-${saveCount}`;
    const text = cleanWebText(String(content));
    const block = [
      summary ? `### ${summary}` : (title ? `### ${title}` : `### Note ${textCount}`),
      url ? `- URL: ${url}` : null,
      reason ? `- Reason: ${String(reason).trim()}` : null,
      '',
      text,
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    appendIndex({
      type: 'text',
      title: summary || title || `Note ${textCount}`,
      url,
      reason,
      summary: summary || title || text,
    });
    return { path: savedPath, name: 'saved.md', count: textCount, recordId };
  }

  // Write a captured image to runs/<id>/assets/ and log a reference block in
  // saved.md (so the image surfaces in the final report). Returns the absolute
  // path. The bulk bytes stay on disk - only the path/summary re-enters the loop.
  function saveImage({ base64, title, url, description, hint, id, ext = 'png', reason } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    saveCount++;
    imageCount++;
    const recordId = `save-${saveCount}`;
    const hintStem = filenameStemFromHint(hint);
    const stem = hintStem ? `${hintStem}-screenshot-${id || imageCount}` : `screenshot-${imageCount}`;
    const name = uniqueAssetName(assetsDir, `${stem}.${ext}`, imageCount);
    const imgPath = path.join(assetsDir, name);
    fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
    const displayTitle = screenshotTitle({ title, hint, count: imageCount });
    const block = [
      `### ${displayTitle}`,
      url ? `- URL: ${url}` : null,
      reason ? `- Reason: ${String(reason).trim()}` : null,
      `- Image: assets/${name}`,
      '',
      `![${markdownLabel(description, name)}](assets/${name})`,
      '',
      (description ?? '').trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    appendIndex({
      type: 'image',
      title: displayTitle,
      url,
      reason,
      assetLabel: 'Image',
      assetPath: `assets/${name}`,
      summary: description || displayTitle || name,
    });
    return { path: imgPath, name, count: imageCount, recordId };
  }

  // Save arbitrary downloaded bytes (a file the page linked or displayed) to
  // assets/ under a sanitized name, and log a saved.md block. `summary` is the
  // model-facing description (vision text for images, metadata otherwise).
  function saveAsset({ base64, filename, summary, url, hint, id, reason } = {}) {
    if (!base64) return null;
    fs.mkdirSync(assetsDir, { recursive: true });
    saveCount++;
    assetCount++;
    const recordId = `save-${saveCount}`;
    // Keep the original extension, but use a durable slug + step id like
    // screenshots do (`read-chart-screenshot-7.jpg`).
    const fallback = String(filename || '').split(/[?#]/)[0].split('/').pop().replace(/[^\w.\-]/g, '_');
    const parsed = path.parse(fallback);
    const stem = filenameStemFromHint(hint) || filenameStemFromHint(parsed.name) || 'download';
    let name = `${stem}-file-${id || assetCount}${parsed.ext}`;
    name = uniqueAssetName(assetsDir, name, assetCount);
    const filePath = path.join(assetsDir, name);
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    const block = [
      summary ? `### ${summary.split('\n')[0].slice(0, 120)}` : `### File ${assetCount}`,
      url ? `- Source: ${url}` : null,
      reason ? `- Reason: ${String(reason).trim()}` : null,
      `- File: assets/${name}`,
      `- Link: [${markdownLabel(name, `File ${assetCount}`)}](assets/${name})`,
      '',
      (summary ?? '').trim(),
      '',
    ].filter(l => l !== null).join('\n');
    fs.appendFileSync(savedPath, block + '\n');
    appendIndex({
      type: 'file',
      title: summary || name,
      source: url,
      reason,
      assetLabel: 'File',
      assetPath: `assets/${name}`,
      summary: summary || name,
    });
    return { path: filePath, name, count: assetCount, recordId };
  }

  function readMarkdown() {
    try { return fs.readFileSync(savedPath, 'utf8'); } catch { return ''; }
  }

  function readIndex() {
    try { return fs.readFileSync(indexPath, 'utf8'); } catch { return ''; }
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
    dir: runDir,
    savedPath,
    indexPath,
    reportPath,
    reportHtmlPath,
    assetsDir,
    saveText,
    saveImage,
    saveAsset,
    readMarkdown,
    readIndex,
    writeReport,
  };
}

module.exports = { createScratchpad, filenameStemFromHint, compactWords, INDEX_SUMMARY_WORDS };
