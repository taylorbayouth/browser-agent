'use strict';

const MarkdownIt = require('markdown-it');
const { cleanUrl } = require('./url');

const TITLE_MAX = 120;
const REPORT_URL_MAX = 20;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateMiddle(value, max = TITLE_MAX) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const keep = Math.max(0, max - 3);
  const head = Math.ceil(keep * 0.58);
  const tail = keep - head;
  return `${text.slice(0, head)}...${text.slice(text.length - tail)}`;
}

function documentTitle(title) {
  return truncateMiddle(compactWhitespace(title) || 'Report');
}

function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  });
  const renderLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return renderLinkOpen(tokens, idx, options, env, self);
  };
  const renderText = md.renderer.rules.text || ((tokens, idx) => escapeHtml(tokens[idx].content));
  md.renderer.rules.text = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const parent = tokens[idx - 1];
    if (parent?.type === 'link_open' && token.content === parent.attrGet('href')) {
      return escapeHtml(cleanUrl(token.content, REPORT_URL_MAX) || token.content);
    }
    return renderText(tokens, idx, options, env, self);
  };
  return md;
}

const defaultRenderer = createMarkdownRenderer();

function markdownToHtml(markdown, { renderer = defaultRenderer } = {}) {
  return renderer.render(String(markdown ?? ''));
}

function reportStyles({ layout = 'report', extraCss = '' } = {}) {
  const frame = layout === 'plain' ? '' : `
body{margin:0;color:#1f2937;background:#f8fafc}
main{max-width:960px;margin:0 auto;padding:40px 24px 64px;background:#fff;min-height:100vh}
@media (max-width:640px){main{padding:28px 16px 48px}}
`;
  return `
:root{color-scheme:light dark}
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
${frame}
h1,h2,h3,h4,h5,h6{line-height:1.2;color:#111827;margin:1.6em 0 .5em}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.35rem;border-bottom:1px solid #e5e7eb;padding-bottom:.25rem}
p,ul,ol,blockquote,pre,table{margin:0 0 1rem}
a{color:#0f766e;overflow-wrap:anywhere;word-break:break-word}
img{max-width:100%;height:auto;border:1px solid #e5e7eb;border-radius:8px;display:block}
td img{width:102px;height:102px;max-width:none;object-fit:cover}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;padding:.1rem .25rem;border-radius:4px}
pre{overflow:auto;background:#111827;color:#f9fafb;padding:1rem;border-radius:6px}
pre code{background:transparent;color:inherit;padding:0}
blockquote{border-left:4px solid #d1d5db;padding:.25rem 0 .25rem 1rem;color:#4b5563;background:#f9fafb}
table{border-collapse:collapse;width:100%;display:block;overflow:auto}
th,td{border:1px solid #e5e7eb;padding:.5rem .65rem;text-align:left;vertical-align:top}
th{background:#f3f4f6}
${extraCss || ''}
@media (prefers-color-scheme:dark){body{background:#111827;color:#d1d5db}main{background:#0f172a}h1,h2,h3,h4,h5,h6{color:#f9fafb}h2{border-color:#374151}code{background:#1f2937}th{background:#1f2937}th,td,img{border-color:#374151}blockquote{border-color:#4b5563;color:#d1d5db;background:#111827}}
`.trim();
}

function markdownToHtmlDocument(markdown, {
  title = 'Report',
  layout = 'report',
  extraCss = '',
  className = 'report',
} = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(documentTitle(title))}</title>
<style>
${reportStyles({ layout, extraCss })}
</style>
</head>
<body>
<main class="${escapeHtml(className)}">
${markdownToHtml(markdown)}
</main>
</body>
</html>
`;
}

module.exports = { markdownToHtml, markdownToHtmlDocument, escapeHtml };
