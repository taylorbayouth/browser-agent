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
const EVIDENCE_PROMPT = `You are inspecting one rendered page region before a browser agent reads the page listing.

Return only JSON, no Markdown, exactly:
{"description":"brief useful visual description","text":"legible text, if any","omit":false,"referenceImage":false}

Set omit true for empty, blank, white, black, transparent, failed-loading, decorative, layout-only, icon-only, or otherwise low-information regions.
Set referenceImage true only when the region is a concrete visual someone may want included in a report.
Do not mention browser chrome or surrounding page layout.`;

const JSON_CONTRACT = `Return only JSON, no Markdown, exactly:
{"summary":"10 words or fewer","description":"full detailed description"}
summary: compact future browser-agent context.
description: complete detailed answer.`;

// Fully static prompt: the vision model describes the image on its own terms,
// with no caller-supplied steer. That keeps the read unbiased (the planner gets
// the whole picture, not just what it thought to ask for) and lets providers
// cache the prompt as a fixed prefix.
function buildPrompt(base) {
  return `${base || DEFAULT_PROMPT}\n\n${JSON_CONTRACT}`;
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

function normalizeEvidenceResult(value) {
  const parsed = (value && typeof value === 'object' && !Array.isArray(value))
    ? value
    : extractJsonObject(value);
  if (parsed) {
    return {
      description: String(parsed.description || '').trim(),
      text: String(parsed.text || '').trim(),
      omit: parsed.omit === true,
      referenceImage: parsed.referenceImage === true,
    };
  }
  const text = String(value || '').trim();
  return { description: text, text: '', omit: false, referenceImage: false };
}

function resolveVisionAdapter() {
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
  return { cfg, adapter, model, maxTokens };
}

async function callVision({ prompt, imageBase64, mimeType, cacheKey, signal } = {}) {
  if (!imageBase64) throw new Error('vision requires imageBase64');
  const { cfg, adapter, model, maxTokens } = resolveVisionAdapter();
  return adapter.describe({
    model,
    prompt,
    imageBase64,
    mimeType,
    cacheKey,
    maxTokens,
    timeoutMs: cfg.timeoutMs,
    signal,
  });
}

// imageBase64: raw base64 image (no data: prefix). Returns a typed result:
// { summary, description }. The short summary is safe for prompt history; the
// full description is for saved artifacts/reports. A non-JSON provider response
// degrades to { summary:first 10 words, description:raw text } instead of
// failing an otherwise-useful screenshot.
async function describe({ imageBase64, mimeType = 'image/png', cacheKey, signal } = {}) {
  const cfg = loadConfig().models?.vision || {};
  const prompt = buildPrompt(cfg.prompt);

  const result = await callVision({
    prompt,
    imageBase64,
    mimeType,
    cacheKey: cacheKey || 'browser-agent:vision',
    signal,
  });
  return normalizeVisionResult(result.text);
}

async function analyzeVisualEvidence({ imageBase64, mimeType = 'image/png', cacheKey, signal } = {}) {
  const result = await callVision({
    prompt: EVIDENCE_PROMPT,
    imageBase64,
    mimeType,
    cacheKey: cacheKey || 'browser-agent:vision-evidence',
    signal,
  });
  return normalizeEvidenceResult(result.text);
}

module.exports = {
  describe,
  analyzeVisualEvidence,
  DEFAULT_PROMPT,
  EVIDENCE_PROMPT,
  normalizeVisionResult,
  normalizeEvidenceResult,
};
