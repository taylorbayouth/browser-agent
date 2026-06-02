'use strict';

// Scroll diagnostic — RUN FROM YOUR TERMINAL (which has Accessibility perms),
// not from inside Claude. With Chrome on port 9222 showing a page:
//
//   node scroll-diag.js
//
// It reports: (1) whether OS input is permitted, (2) whether the cursor lands
// where we aim it, (3) which CGEvent wheel variant actually scrolls the feed's
// inner <main> container. Needs the test binary at /tmp/scroll-test (built from
// /tmp/scroll-test.swift); falls back to pixel-only if absent.

const CDP = require('chrome-remote-interface');
const { spawn, spawnSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// ../ — this script lives in tools/, the binary in native/ at the repo root.
const BIN = path.resolve(__dirname, '..', 'native/macos/browser-input/bin/browser-input');
const TEST_BIN = '/tmp/scroll-test';

function browserInputClient() {
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', seq = 0; const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => { buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1);
      if (!l) continue; try { const m = JSON.parse(l); const p = pending.get(m.id); if (p){pending.delete(m.id); p(m.data||{});} } catch{} } });
  return { send(cmd){ const id=String(++seq); return new Promise(res=>{ pending.set(id,res); child.stdin.write(JSON.stringify({id,...cmd})+'\n'); }); }, kill(){ child.kill(); } };
}

async function scrollerTop(client) {
  const { result } = await client.Runtime.evaluate({ returnByValue: true,
    expression: `(() => { let b=null; for (const el of document.querySelectorAll('*')) { const cs=getComputedStyle(el);
      if((cs.overflowY==='auto'||cs.overflowY==='scroll')&&el.scrollHeight>el.clientHeight+50&&el.clientHeight>200){ if(!b||el.scrollHeight>b.scrollHeight)b=el; } }
      return b?{top:Math.round(b.scrollTop),tag:b.tagName.toLowerCase(),h:b.scrollHeight,ch:b.clientHeight}:null; })()` });
  return result.value;
}
async function resetScroller(client){ await client.Runtime.evaluate({ expression:`(() => { let b=null; for (const el of document.querySelectorAll('*')){const cs=getComputedStyle(el); if((cs.overflowY==='auto'||cs.overflowY==='scroll')&&el.scrollHeight>el.clientHeight+50&&el.clientHeight>200){if(!b||el.scrollHeight>b.scrollHeight)b=el;}} if(b)b.scrollTop=0; })()` }); }

async function main() {
  const rc = browserInputClient();
  const ax = await rc.send({ op: 'axtrusted' });
  console.log(`[1] Accessibility trusted for this process: ${ax.trusted}`);
  if (!ax.trusted) { console.log('    -> run this from a Terminal that has Accessibility permission.'); rc.kill(); process.exit(1); }

  const targets = await CDP.List({ port: 9222 });
  const feed = targets.find(t => t.type === 'page' && /linkedin\.com\/feed/.test(t.url)) || targets.find(t => t.type==='page');
  const client = await CDP({ target: feed, port: 9222 });
  await client.Page.enable(); await client.Runtime.enable();

  const sc = await scrollerTop(client);
  console.log(`[2] page: ${feed.url}`);
  console.log(`    inner scroller: ${sc ? `<${sc.tag}> scrollHeight=${sc.h} clientHeight=${sc.ch}` : 'NONE (page scrolls window)'}`);

  // page-center -> screen
  const { windowId } = await client.Browser.getWindowForTarget({ targetId: feed.id });
  const { bounds } = await client.Browser.getWindowBounds({ windowId });
  const m = await client.Page.getLayoutMetrics();
  const lv = m.cssLayoutViewport || {}, vv = m.cssVisualViewport || {};
  const vw = vv.clientWidth ?? lv.clientWidth, vh = vv.clientHeight ?? lv.clientHeight;
  const scr = { x: bounds.left + Math.max(0,bounds.width-vw) + vw/2, y: bounds.top + Math.max(0,bounds.height-vh) + vh/2 };

  execSync(`osascript -e 'tell application "Google Chrome" to activate'`);
  await sleep(600);
  await rc.send({ op: 'move', x: scr.x, y: scr.y, speedPxPerSec: 1e9, jitterPx: 0 });
  await sleep(200);
  const pos = await rc.send({ op: 'pos' });
  const dErr = Math.round(Math.hypot(pos.x-scr.x, pos.y-scr.y));
  console.log(`[3] cursor targeting: aimed (${Math.round(scr.x)},${Math.round(scr.y)}) landed (${Math.round(pos.x)},${Math.round(pos.y)})  error=${dErr}px ${dErr>10?'❌ MISMATCH (coordinate-mapping bug)':'✓'}`);

  // wheel variants
  const haveTest = fs.existsSync(TEST_BIN);
  const variants = haveTest ? [['pixel',534],['line',15],['pixelphase',534]] : [['pixel(browser-input)',534]];
  console.log('[4] which wheel variant scrolls the inner scroller?');
  for (const [mode, delta] of variants) {
    await resetScroller(client); await sleep(300);
    execSync(`osascript -e 'tell application "Google Chrome" to activate'`); await sleep(400);
    const before = (await scrollerTop(client))?.top;
    if (haveTest) spawnSync(TEST_BIN, [String(Math.round(scr.x)), String(Math.round(scr.y)), mode, String(delta)]);
    else { await rc.send({ op:'move', x:scr.x, y:scr.y, speedPxPerSec:1e9, jitterPx:0 }); await rc.send({ op:'scroll', dx:0, dy:-delta }); }
    await sleep(700);
    const after = (await scrollerTop(client))?.top;
    console.log(`    ${mode.padEnd(18)} scrollTop ${before} -> ${after}   ${after-before>0?'✓ SCROLLS':'❌ no movement'}`);
  }

  // control: CDP wheel (bypasses OS) — proves the element is scrollable
  await resetScroller(client); await sleep(300);
  const cb = (await scrollerTop(client))?.top;
  await client.Input.dispatchMouseEvent({ type:'mouseWheel', x: vw/2, y: vh/2, deltaX:0, deltaY:534 });
  await sleep(500);
  console.log(`[5] CONTROL (CDP wheel, no OS): scrollTop ${cb} -> ${(await scrollerTop(client))?.top}`);

  rc.kill(); await client.close(); process.exit(0);
}
main().catch(e => { console.error('ERROR:', e.stack||e.message); process.exit(1); });
