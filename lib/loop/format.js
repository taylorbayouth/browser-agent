'use strict';

// Pure text/format helpers shared across the loop. No I/O, no session, no config
// — just string shaping for the event log, turn message, and terminal output.

const LOG_URL_MAX = 20;

// Horizontal rule that brackets the history block, so the model can clearly tell
// "what I've already done" apart from the current page it must act on.
const RULE = '────────────────────────────────────────────────────';

function quote(s) {
  return `"${String(s ?? '').replace(/"/g, '\\"')}"`;
}

function hasText(s) {
  return String(s ?? '').trim().length > 0;
}

function compactWords(s, maxWords = 15) {
  const words = String(s ?? '').trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!words.length) return '';
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}...` : words.join(' ');
}

function compactWhitespace(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

function compactPreview(s, max = 1200) {
  const text = compactWhitespace(s);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// One-line summary of where the viewport sits in the document, so the model can
// decide whether scrolling will reveal anything (it scrolls blind otherwise).
function scrollSummary(vp) {
  if (!vp) return '';
  const dims = `${vp.width || '?'}x${vp.height || '?'}`;
  const { scrollY, height, contentHeight } = vp;
  if (!contentHeight || !height || contentHeight <= height + 1) {
    return `${dims}, whole page fits in view (nothing to scroll)`;
  }
  const maxScroll = contentHeight - height;
  const pct = Math.round(Math.min(1, Math.max(0, scrollY / maxScroll)) * 100);
  const where = scrollY <= 1 ? 'at top, more below'
    : scrollY >= maxScroll - 1 ? 'at bottom'
    : 'more above and below';
  return `${dims}, scrolled ${Math.round(scrollY)}/${Math.round(contentHeight)}px (${pct}%, ${where})`;
}

// "Turn 3/25 | 2,623 in · 145 out | 63% cached"
function fmtTurn(iter, maxSteps, usage, mode = null) {
  const parts = [`Turn ${iter}/${maxSteps}`];
  if (usage) {
    const fmt = (n) => (n || 0).toLocaleString();
    parts.push(`${fmt(usage.inputTokens)} in · ${fmt(usage.outputTokens)} out`);
    const pct = (usage.cacheReadTokens && usage.inputTokens)
      ? Math.round(usage.cacheReadTokens / usage.inputTokens * 100)
      : 0;
    parts.push(`${pct}% cached`);
  }
  if (mode) parts.push(`mode=${mode}`);
  return parts.join(' | ');
}

module.exports = {
  LOG_URL_MAX,
  RULE,
  quote,
  hasText,
  compactWords,
  compactWhitespace,
  compactPreview,
  scrollSummary,
  fmtTurn,
};
