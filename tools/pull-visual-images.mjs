#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSnapshotMaps, deriveDeviceScale, STYLE_PROPS } = require('../lib/extract');
const { collectVisualImages } = require('../lib/visual-images');

const pageUrl = process.argv[2];
if (!pageUrl) {
  console.error('Usage: node tools/pull-visual-images.mjs <url> [output.json]');
  process.exit(1);
}

const output = process.argv[3] || process.env.OUT || 'outputs/visual-images.json';
const endpoint = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const waitMs = Number(process.env.WAIT_MS || 2000);
const visualImageTimeoutMs = Number(process.env.VISUAL_IMAGE_TIMEOUT_MS || 150);

async function json(path, method = 'GET') {
  const res = await fetch(`${endpoint}${path}`, { method });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res.json();
}

let id = 0;
let ws;
let target;
const pending = new Map();
pending.events = [];

function command(method, params = {}) {
  const commandId = ++id;
  ws.send(JSON.stringify({ id: commandId, method, params }));
  return new Promise((resolve, reject) => pending.set(commandId, { resolve, reject }));
}

function waitFor(method, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    pending.events.push((msg) => {
      if (msg.method !== method) return false;
      clearTimeout(timeout);
      resolve(msg.params);
      return true;
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

try {
  try {
    target = await json(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  } catch {
    target = await json(`/json/new?${encodeURIComponent('about:blank')}`);
  }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    pending.events = pending.events.filter(listener => !listener(msg));
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  await command('Page.enable');
  const loaded = waitFor('Page.loadEventFired');
  await command('Page.navigate', { url: pageUrl });
  await loaded;
  await delay(waitMs);

  const [snapshot, metrics] = await Promise.all([
    command('DOMSnapshot.captureSnapshot', {
      computedStyles: STYLE_PROPS,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    }),
    command('Page.getLayoutMetrics'),
  ]);
  const viewport = {
    width: metrics.cssLayoutViewport.clientWidth,
    height: metrics.cssLayoutViewport.clientHeight,
    scrollX: metrics.cssLayoutViewport.pageX,
    scrollY: metrics.cssLayoutViewport.pageY,
  };
  const maps = buildSnapshotMaps(snapshot);
  maps.scale = deriveDeviceScale(metrics);

  const images = collectVisualImages(snapshot, maps, viewport, { visualImageTimeoutMs });
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(output, JSON.stringify(images, null, 2));
  console.log(`wrote ${images.length} image records to ${output}`);
} finally {
  if (ws) ws.close();
  if (target?.id) await fetch(`${endpoint}/json/close/${target.id}`).catch(() => {});
}
