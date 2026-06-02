'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_AVERAGE_SIDE_PX = 400;

let sharpModule;
let sharpLoadAttempted = false;

function loadSharp() {
  if (sharpLoadAttempted) return sharpModule;
  sharpLoadAttempted = true;
  try {
    sharpModule = require('sharp');
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

function resizeDimensions(width, height, targetAverageSide = DEFAULT_AVERAGE_SIDE_PX) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(targetAverageSide) || targetAverageSide <= 0) return null;
  const averageSide = (width + height) / 2;
  if (averageSide <= targetAverageSide) return null;
  const scale = targetAverageSide / averageSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function resizeImageBuffer(buffer, opts = {}) {
  if (!buffer?.length) return { buffer, metadata: null };
  const sharp = loadSharp();
  const targetAverageSide = opts.targetAverageSide ?? DEFAULT_AVERAGE_SIDE_PX;
  if (targetAverageSide === 0 || targetAverageSide === false) return { buffer, metadata: null };

  if (sharp) {
    try {
      const image = sharp(buffer, { animated: false, failOn: 'none' });
      const before = await image.metadata();
      const target = resizeDimensions(before.width, before.height, targetAverageSide);
      if (!target) return { buffer, metadata: before };

      const resized = await image
        .resize({ ...target, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
      return {
        buffer: resized,
        metadata: resizedMetadata(before, target, targetAverageSide),
      };
    } catch {}
  }

  return resizeWithPlatformTool(buffer, { ...opts, targetAverageSide });
}

function resizedMetadata(before, target, targetAverageSide) {
  return {
    ...before,
    resized: true,
    originalWidth: before.width,
    originalHeight: before.height,
    width: target.width,
    height: target.height,
    targetAverageSide,
  };
}

function commandExists(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseSipsDimensions(text) {
  const width = Number(text.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(text.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return { width, height };
}

function parseIdentifyDimensions(text) {
  const [width, height] = String(text).trim().split(/\s+/).map(Number);
  return { width, height };
}

function resizeWithPlatformTool(buffer, opts = {}) {
  const ext = String(opts.ext || 'png').toLowerCase().replace(/^jpeg$/, 'jpg');
  if (!['png', 'jpg', 'webp'].includes(ext)) return { buffer, metadata: null };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-image-'));
  const input = path.join(dir, `input.${ext}`);
  const output = path.join(dir, `output.${ext}`);
  try {
    fs.writeFileSync(input, buffer);
    let before, resize;
    if (process.platform === 'darwin' && commandExists('sips')) {
      before = parseSipsDimensions(execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', input], { encoding: 'utf8' }));
      resize = (target) => execFileSync('sips', ['-s', 'format', ext === 'jpg' ? 'jpeg' : ext, '-z', String(target.height), String(target.width), input, '--out', output], { stdio: 'ignore' });
    } else {
      const magick = commandExists('magick') ? 'magick' : (commandExists('convert') && commandExists('identify') ? 'convert' : null);
      if (!magick) return { buffer, metadata: null };
      const identify = magick === 'magick' ? ['magick', 'identify'] : ['identify'];
      before = parseIdentifyDimensions(execFileSync(identify[0], [...identify.slice(1), '-format', '%w %h', input], { encoding: 'utf8' }));
      resize = (target) => execFileSync(magick, [...(magick === 'magick' ? [input] : [input]), '-resize', `${target.width}x${target.height}`, output], { stdio: 'ignore' });
    }
    const target = resizeDimensions(before.width, before.height, opts.targetAverageSide);
    if (!target) return { buffer, metadata: before };
    resize(target);
    return {
      buffer: fs.readFileSync(output),
      metadata: resizedMetadata(before, target, opts.targetAverageSide),
    };
  } catch {
    return { buffer, metadata: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { DEFAULT_AVERAGE_SIDE_PX, resizeDimensions, resizeImageBuffer };
