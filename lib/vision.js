'use strict';

// Secondary vision model. The `screenshot` verb captures the page as an image
// and calls describe() here to turn it into text the planner can read.
//
// This module owns the *orchestration* — config, prompt assembly, and JSON
// normalization — but the per-provider wire format lives on each adapter's
// describe() method (lib/providers/*). We resolve the adapter from the registry
// and call it, so adding a vision provider is just implementing describe() on
// its adapter; no dispatch ladder lives here anymore.

const { providers } = require('./providers');
const { loadConfig } = require('./config');

const DEFAULT_PROMPT = 'Describe the image/page in detail, 1500-2000 chars.';

const JSON_CONTRACT = `Return only JSON, no Markdown, exactly:
{"summary":"10 words or fewer","description":"full detailed description"}
summary: compact future browser-agent context.
description: complete detailed answer.`;

// Static base prompt + an optional caller hint about what to look for. The hint
// is what makes this useful for targeted reads (a CAPTCHA wants "read the
// characters", not a paragraph about the page's color scheme).
function buildPrompt(base, hint) {
  const p = base || DEFAULT_PROMPT;
  const focus = hint ? `\n\nFocus especially on: ${hint}` : '';
  return `${p}${focus}\n\n${JSON_CONTRACT}`;
}

function firstWords(text, maxWords = 10) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(' ');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

function normalizeVisionResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const description = String(value.description || value.summary || '').trim();
    const summary = firstWords(value.summary || description);
    return { summary, description };
  }
  const text = String(value || '').trim();
  const parsed = extractJsonObject(text);
  if (parsed) return normalizeVisionResult(parsed);
  return { summary: firstWords(text), description: text };
}

// imageBase64: raw base64 image (no data: prefix). Returns a typed result:
// { summary, description }. The short summary is safe for prompt history; the
// full description is for saved artifacts/reports. A non-JSON provider response
// degrades to { summary:first 10 words, description:raw text } instead of
// failing an otherwise-useful screenshot.
async function describe({ imageBase64, mimeType = 'image/png', hint, cacheKey, signal } = {}) {
  if (!imageBase64) throw new Error('vision.describe requires imageBase64');

  const cfg = loadConfig().models?.vision || {};
  const providerName = cfg.provider || 'openai';
  const adapter = providers[providerName];
  if (!adapter) {
    throw new Error(`vision: unknown provider "${providerName}" (have: ${Object.keys(providers).join(', ')})`);
  }
  if (typeof adapter.describe !== 'function' || !adapter.capabilities?.vision) {
    throw new Error(`vision: provider "${providerName}" does not support image description`);
  }

  const model = cfg.model || adapter.defaultVisionModel;
  if (!model) throw new Error(`vision: no model configured for provider "${providerName}" (set vision.model)`);
  const maxTokens = Number.isFinite(cfg.maxTokens) ? cfg.maxTokens : 1024;
  const timeoutMs = cfg.timeoutMs;
  const prompt = buildPrompt(cfg.prompt, hint);

  const result = await adapter.describe({
    model,
    prompt,
    imageBase64,
    mimeType,
    cacheKey: cacheKey || 'browser-agent:vision',
    maxTokens,
    timeoutMs,
    signal,
  });
  return normalizeVisionResult(result.text);
}

module.exports = {
  describe,
  DEFAULT_PROMPT,
  normalizeVisionResult,
};
