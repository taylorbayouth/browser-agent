'use strict';

// On-demand file discovery, invisible by construction.
//
// File links are not always obvious in the perception listing. When the model
// needs to find one, get_files scans for it here, using only DevTools DOM reads —
// DOM.querySelectorAll / getAttributes. No JavaScript runs in the page, nothing
// mutates, no events fire: the same out-of-process channel perception uses.
//
// Per-node reads (vs parsing a DOMSnapshot's column tables) are a deliberate
// choice: a few more protocol calls in exchange
// for code that's obvious to read and debug.

// File extensions get_files treats as "downloadable". Images are intentionally
// absent; save_file can still save an image URL when the page exposes one.
const FILE_EXTS = new Set([
  'pdf', 'csv', 'tsv', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx',
  'zip', 'gz', 'tar', 'rtf', 'txt', 'md', 'json', 'xml', 'epub',
]);

// Hard cap on nodes examined per scan, so a pathological page (thousands of
// nodes) can't turn discovery into a protocol-call storm.
const MAX_NODES = 400;

function attrMap(flat) {
  const m = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) m[flat[i]] = flat[i + 1];
  return m;
}

function absUrl(raw, base) {
  try { return new URL(raw, base || undefined).href; } catch { return null; }
}

function extOf(url) {
  try {
    const ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase();
    return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
  } catch { return null; }
}

function basenameOf(url) {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(name) || null;
  } catch { return null; }
}

// One scan setup: register the document and return a scoped querySelectorAll plus
// the page URL (for resolving relative links).
async function begin(client) {
  await client.DOM.enable();
  const { root } = await client.DOM.getDocument({});
  const rootId = root.nodeId;
  const baseUrl = root.documentURL || null;
  const query = async (selector) => {
    try {
      const { nodeIds } = await client.DOM.querySelectorAll({ nodeId: rootId, selector });
      return (nodeIds || []).slice(0, MAX_NODES);
    } catch { return []; }
  };
  return { baseUrl, query };
}

async function attrsOf(client, nodeId) {
  try { return attrMap((await client.DOM.getAttributes({ nodeId })).attributes); }
  catch { return {}; }
}

async function scanFiles(client) {
  if (!client) return [];
  const { baseUrl, query } = await begin(client);
  const ids = await query('a[href], embed[src], object[data], iframe[src]');
  const seen = new Set();
  const out = [];
  for (const nodeId of ids) {
    const a = await attrsOf(client, nodeId);
    const url = absUrl(a.href || a.src || a.data, baseUrl);
    if (!url || seen.has(url)) continue;
    const ext = extOf(url);
    const isFile = a.download != null || (ext && FILE_EXTS.has(ext));
    if (!isFile) continue;
    seen.add(url);
    out.push({ url, filename: basenameOf(url) || (a.download || '').trim() || 'file', ext: ext || null });
  }
  return out;
}

// ── Verb handlers ─────────────────────────────────────────────────────────────
// Format a scan into one compact, capped block for the event log. The model
// reads it next turn and passes a chosen URL to save_file. Capped so a large
// downloads page can't flood the prompt.

const FILE_LIST_CAP = 20;

function formatFiles(files) {
  if (!files.length) return 'No downloadable files found on this page.';
  const shown = files.slice(0, FILE_LIST_CAP).map((f, i) =>
    `  ${i + 1}. ${f.filename}${f.ext ? ` (.${f.ext})` : ''} — ${f.url}`);
  const more = files.length > FILE_LIST_CAP ? `\n  …and ${files.length - FILE_LIST_CAP} more` : '';
  return `Found ${files.length} file(s):\n${shown.join('\n')}${more}\n` +
         `Pass one of these URLs to save_file to save it.`;
}

async function getFiles({ session } = {}) {
  const files = await scanFiles(session?.client);
  return { summary: formatFiles(files), count: files.length };
}

module.exports = { scanFiles, getFiles, FILE_EXTS };
