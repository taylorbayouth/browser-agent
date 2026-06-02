'use strict';

// The `save_file` verb and shared resource downloader. save_file downloads the
// real bytes at a URL — typically one the model got from get_files (or a link it
// sees in the listing) — and hands them back for the loop to persist under
// assets/. save_image reuses the downloader when a visual region has an internal
// source URL. save_file describes images with vision; image promotion avoids
// another vision call.
//
// Download strategy (no page JS):
//   data:        decode the URI directly.
//   loaded:      Page.getResourceContent reads the page's cached bytes — exact
//                original, no CSP/CORS check (the page already loaded it).
//   cold:        Network.loadNetworkResource re-fetches in page context; this IS
//                subject to the page's CSP, so a cold cross-origin URL may fail —
//                the error tells the model to navigate to it first.

const vision = require('./vision');

// Bound how much a single save_file can pull. The url can come from page content
// the model just read, so an unbounded fetch is a memory/DoS foot-gun; 12 MB
// comfortably covers real images/PDFs. Images past 5 MB skip the vision describe
// (it would downscale them anyway) and fall back to a metadata summary.
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_VISION_BYTES = 5 * 1024 * 1024;
const mb = (n) => Math.round(n / (1024 * 1024));

// Magic-byte sniff → mime + extension. Reliable regardless of URL/headers.
function sniff(buf) {
  const hex = buf.slice(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return { mime: 'image/png', ext: 'png' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (hex.startsWith('47494638')) return { mime: 'image/gif', ext: 'gif' };
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (/^\s*<svg[\s>]/i.test(buf.slice(0, 512).toString('utf8'))) return { mime: 'image/svg+xml', ext: 'svg' };
  if (hex.startsWith('25504446')) return { mime: 'application/pdf', ext: 'pdf' };
  return { mime: null, ext: null };
}

function extFromUrl(url) {
  try {
    const ext = (new URL(url).pathname.split('.').pop() || '').toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : null;
  } catch {
    return null;
  }
}

async function download(client, frameId, url, maxBytes) {
  // Primary: already-loaded bytes from cache — exact original, no CSP check.
  try {
    const { content, base64Encoded } = await client.Page.getResourceContent({ frameId, url });
    if (content != null) return Buffer.from(content, base64Encoded ? 'base64' : 'utf8');
  } catch {}
  // Fallback: re-fetch in page context (subject to CSP; works same-origin).
  // includeCredentials:false — a model-supplied url shouldn't ride the user's
  // cookies to an arbitrary endpoint; genuinely same-origin page assets are served
  // by the getResourceContent path above (with the page's own auth).
  try {
    await client.Network.enable();
    const res = await client.Network.loadNetworkResource({
      frameId, url, options: { disableCache: false, includeCredentials: false },
    });
    if (res.resource?.success && res.resource.stream) {
      let buf = Buffer.alloc(0), eof = false;
      while (!eof) {
        const c = await client.IO.read({ handle: res.resource.stream });
        buf = Buffer.concat([buf, Buffer.from(c.data, c.base64Encoded ? 'base64' : 'utf8')]);
        eof = c.eof;
        // Stop accumulating once over the cap — saveFile rejects on size, so
        // there's no point streaming a huge resource fully into memory first.
        if (maxBytes && buf.length > maxBytes) break;
      }
      await client.IO.close({ handle: res.resource.stream }).catch(() => {});
      return buf;
    }
  } catch {}
  return null;
}

async function downloadResource({ session, client, brief, url, maxBytes = MAX_DOWNLOAD_BYTES } = {}) {
  client = client || session?.client;
  if (!client) throw new Error('downloadResource requires a CDP session');
  if (!url || typeof url !== 'string') throw new Error('downloadResource requires a url');

  let buf, resolvedUrl;
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const isB64 = /;base64/i.test(url.slice(5, comma));
    const payload = url.slice(comma + 1);
    buf = isB64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    resolvedUrl = '(data URI)';
  } else {
    let parsed;
    try { parsed = new URL(url, brief?.url || undefined); }
    catch { throw new Error(`downloadResource: invalid url "${url}"`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`downloadResource refuses "${parsed.protocol}" — only http(s) and data: URLs are allowed`);
    }
    resolvedUrl = parsed.href;
    const { frameTree } = await client.Page.getFrameTree();
    buf = await download(client, frameTree.frame.id, resolvedUrl, maxBytes);
  }
  if (!buf || !buf.length) throw new Error(`downloadResource: could not download ${resolvedUrl}`);
  if (buf.length > maxBytes) throw new Error(`downloadResource: ${resolvedUrl} exceeds the ${mb(maxBytes)}MB limit`);

  const sniffed = sniff(buf);
  const ext = sniffed.ext || extFromUrl(resolvedUrl);
  let filename = url.startsWith('data:') ? 'file' : (new URL(resolvedUrl).pathname.split('/').pop() || 'file');
  if (!/\.\w+$/.test(filename) && ext) filename = `${filename}.${ext}`;
  return {
    bytes: buf,
    base64: buf.toString('base64'),
    filename,
    mimeType: sniffed.mime,
    ext,
    sourceUrl: resolvedUrl,
  };
}

async function saveFile({ session, brief, url, hint, signal } = {}) {
  if (!session?.client) throw new Error('save_file requires a CDP session');
  if (!url || typeof url !== 'string') throw new Error('save_file requires a url (use get_files or a visible link to find one)');

  let downloaded;
  try {
    downloaded = await downloadResource({ session, brief, url, maxBytes: MAX_DOWNLOAD_BYTES });
  } catch (err) {
    const message = err?.message || String(err);
    if (/could not download/.test(message)) {
      throw new Error(`save_file: could not download ${url} — it may not be loaded yet, or the page's CSP blocked the fetch. Navigate to it first, then save_file.`);
    }
    throw new Error(message.replace(/^downloadResource/, 'save_file'));
  }
  const { bytes: buf, filename, mimeType: mime, ext, sourceUrl: resolvedUrl } = downloaded;

  let summary, description;
  if (mime && mime.startsWith('image/') && buf.length > MAX_VISION_BYTES) {
    // Too big to describe with vision (it would just downscale it) — save the
    // bytes and hand back a metadata summary instead.
    const kb = Math.max(1, Math.round(buf.length / 1024));
    summary = `Downloaded ${filename} (${mime}, ${kb} KB) from ${resolvedUrl} — too large to describe with vision; saved as-is.`;
    description = summary;
  } else if (mime && mime.startsWith('image/')) {
    const described = vision.normalizeVisionResult(
      await vision.describe({ imageBase64: buf.toString('base64'), mimeType: mime, hint, signal }),
    );
    summary = described.summary;
    description = described.description;
  } else {
    const kb = Math.max(1, Math.round(buf.length / 1024));
    summary = `Downloaded ${filename} (${mime || ext || 'unknown type'}, ${kb} KB) from ${resolvedUrl}`;
    description = summary;
  }

  return { fileBytes: buf.toString('base64'), filename, mimeType: mime, sourceUrl: resolvedUrl, summary, description, hint: hint || null };
}

module.exports = { saveFile, downloadResource, sniff };
