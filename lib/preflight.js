'use strict';

// Preflight — the "just works" front door for the single entry point.
// Walks a fixed sequence of checks, fixing what it can and prompting for the
// rest. Each step is a no-op when already satisfied, so re-running is safe.
//
//   0. env          .env exists (copy from .env.example if not)
//   1. deps         node_modules present (else `npm install`)
//   2. driver       browser-input binary present — macOS: download or build;
//                   Linux: build from source (no prebuilt release published)
//   3. permission   OS input usable (macOS Accessibility / Linux X11 reachable)
//   4. creds        first run: offer all three provider keys (each skippable),
//                   then ensure the in-use provider's key is set — prompts and
//                   saves to .env if not
//   5. chrome       running on the debug port (else launch it)

const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const readline = require('readline');

const {
  launch, mainChromePid, DEFAULT_PROFILE_DIR,
} = require('./launch');

const ROOT         = path.resolve(__dirname, '..');
const ENV_PATH     = path.join(ROOT, '.env');
const ENV_EXAMPLE  = path.join(ROOT, '.env.example');
// Native helper lives under a per-platform dir; mirror lib/executors/os.js's
// PLATFORM_BIN so preflight checks/builds the exact binary the os executor
// spawns. (Anything other than linux resolves to the macOS layout, matching
// os.js's `|| PLATFORM_BIN.darwin` fallback.)
const NATIVE_OS    = process.platform === 'linux' ? 'linux' : 'macos';
const BIN_PATH     = path.resolve(ROOT, 'native', NATIVE_OS, 'browser-input', 'bin', 'browser-input');
const BUILD_SCRIPT = path.resolve(ROOT, 'native', NATIVE_OS, 'browser-input', 'build.sh');
const GITHUB_REPO  = 'taylorbayouth/browser-agent';
// The driver version this checkout expects. Bumped in lockstep with
// DRIVER_VERSION in the native sources (macos/main.swift, linux/main.c). An
// installed binary reporting less than this — or an old one with no `version`
// op at all — is treated as outdated and refreshed, so a `git pull` that updates
// the driver source actually reaches the running binary.
const EXPECTED_DRIVER_VERSION = 2;

const KEY_FOR = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

// The providers offered up front by the first-run credential setup (step 4),
// in prompt order, each with the label shown to the user. Gemini is Google's
// API, so it's labelled accordingly.
const SETUP_PROVIDERS = [
  { keyName: 'OPENAI_API_KEY',    label: 'OpenAI' },
  { keyName: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
  { keyName: 'GEMINI_API_KEY',    label: 'Google (Gemini)' },
];

class PreflightError extends Error {}

function log(msg) {
  process.stderr.write(`[preflight] ${msg}\n`);
}

// ── Interactive helpers ────────────────────────────────────────────────────────

// Interactive prompts need a TTY. In a non-interactive context (CI, a piped
// run, a fresh-clone script) readline would block forever on stdin with no way
// to answer — fail fast with actionable guidance instead. PreflightError prints
// cleanly (no stack) and exits 2 via agent.js. Covers choose()/ensureCreds too.
function assertTTY(question) {
  if (!process.stdin.isTTY) {
    throw new PreflightError(
      `Setup needs an interactive answer ("${question.trim()}") but stdin is not a TTY.\n` +
      `Run browser-agent in a terminal, or pre-provide what it's asking for: set the\n` +
      `provider API key env var, pass --executor cdp, or set executor.binPath — so\n` +
      `preflight has nothing left to prompt for.`
    );
  }
}

function prompt(question) {
  assertTTY(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

// Like prompt(), but the typed answer is never echoed — for secrets (API keys)
// that would otherwise be printed to the screen and into any terminal recording.
// We write the question ourselves, then suppress readline's own output so each
// keystroke leaves no trace; a trailing newline keeps the cursor tidy.
function promptHidden(question) {
  assertTTY(question);
  process.stderr.write(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {};
  return new Promise(resolve => {
    rl.question('', answer => { process.stderr.write('\n'); rl.close(); resolve(answer.trim()); });
  });
}

async function choose(question, options) {
  process.stderr.write(`\n[preflight] ${question}\n`);
  options.forEach((o, i) => process.stderr.write(`  ${i + 1}. ${o.label}\n`));
  const raw = await prompt('> ');
  const idx = parseInt(raw, 10) - 1;
  return options[Math.max(0, Math.min(options.length - 1, isNaN(idx) ? 0 : idx))];
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 5;

function fetchJson(url, depth = 0) {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'browser-agent-preflight' } };
    https.get(url, opts, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (depth >= MAX_REDIRECTS) return reject(new Error(`Too many redirects fetching ${url}`));
        return fetchJson(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      https.get(u, { headers: { 'User-Agent': 'browser-agent-preflight' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (depth >= MAX_REDIRECTS) return reject(new Error(`Too many redirects downloading ${url}`));
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Step 0 — .env ─────────────────────────────────────────────────────────────

function ensureEnvFile() {
  if (fs.existsSync(ENV_PATH)) return;
  if (fs.existsSync(ENV_EXAMPLE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
    log('Created .env from .env.example.');
  }
}

// ── Step 1 — node_modules ─────────────────────────────────────────────────────

function ensureDeps() {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return;
  log('node_modules missing — running npm install...');
  execFileSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit' });
}

// ── Step 2 — browser-input binary ───────────────────────────────────────────────

async function downloadDriver() {
  log('Fetching latest release from GitHub...');
  let release;
  try {
    release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  } catch (e) {
    throw new PreflightError(`Could not reach GitHub releases: ${e.message}`);
  }

  const asset = release.assets?.find(a => a.name.endsWith('.zip') && a.name.includes('macos'));
  if (!asset) throw new PreflightError('No macOS binary found in latest release. Try building from source instead.');

  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-agent-'));
  const zipPath    = path.join(tmpDir, asset.name);
  const mountPoint = path.join(tmpDir, 'mount');

  try {
    log(`Downloading ${asset.name}...`);
    await downloadFile(asset.browser_download_url, zipPath);

    execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`);
    const dmgName = fs.readdirSync(tmpDir).find(f => f.endsWith('.dmg'));
    if (!dmgName) throw new PreflightError('No .dmg found inside the downloaded zip.');

    fs.mkdirSync(mountPoint, { recursive: true });
    execSync(`hdiutil attach -nobrowse -quiet -mountpoint "${mountPoint}" "${path.join(tmpDir, dmgName)}"`);

    try {
      fs.mkdirSync(path.dirname(BIN_PATH), { recursive: true });
      const dmgBin = fs.readdirSync(mountPoint).find(f => !f.startsWith('.'));
      if (!dmgBin) throw new PreflightError('No binary found inside the mounted DMG.');
      fs.copyFileSync(path.join(mountPoint, dmgBin), BIN_PATH);
      fs.chmodSync(BIN_PATH, 0o755);
    } finally {
      try { execSync(`hdiutil detach "${mountPoint}" -quiet`); } catch {}
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  log('browser-input installed.');
}

function buildDriver() {
  log('Building browser-input from source...');
  try {
    execFileSync('bash', [BUILD_SCRIPT], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    const hint = process.platform === 'linux'
      ? 'Build failed. Install a C compiler and the X11 dev headers, then re-run:\n' +
        '  Ubuntu/Debian:  sudo apt install gcc libx11-dev libxtst-dev libxss-dev\n' +
        '  Fedora/RHEL:    sudo dnf install gcc libX11-devel libXtst-devel libXScrnSaver-devel\n' +
        '  Arch:           sudo pacman -S gcc libx11 libxtst libxss'
      : 'Build failed. Install Xcode command-line tools:\n' +
        '  xcode-select --install\n' +
        'then re-run.';
    throw new PreflightError(hint);
  }
}

// Ask the helper for its build version. Returns 0 for an older binary that
// predates the `version` op (it replies ok:false → helperOneShot resolves null)
// or any probe failure, so callers can treat "can't tell" as "outdated".
async function driverVersion(binPath) {
  const data = await helperOneShot(binPath, { op: 'version' });
  const v = data?.version;
  return Number.isFinite(v) ? v : 0;
}

function hasSwiftc() {
  try {
    execSync('command -v swiftc', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Re-acquire the driver to pick up a newer version. Linux can only build from
// source. macOS prefers a source rebuild when the Xcode toolchain is present —
// that compiles the freshly-pulled main.swift, which is the `git pull` developer
// case — and otherwise fetches the latest notarized release for users without
// build tools.
async function upgradeDriver() {
  if (process.platform === 'linux') { buildDriver(); return; }
  if (hasSwiftc()) buildDriver();
  else await downloadDriver();
}

async function ensureDriverCurrent(binPath) {
  const have = await driverVersion(binPath);
  if (have >= EXPECTED_DRIVER_VERSION) return;

  log(`browser-input is outdated (have v${have || '?'}, need v${EXPECTED_DRIVER_VERSION}) — updating...`);
  try {
    await upgradeDriver();
  } catch (e) {
    // An update failure shouldn't block a run on an otherwise-working binary —
    // it just keeps the old behavior. Warn loudly and proceed.
    log(`warning: could not update browser-input (${e.message}). Continuing with the installed v${have || '?'}.`);
    return;
  }
  const now = await driverVersion(binPath);
  if (now < EXPECTED_DRIVER_VERSION) {
    log(
      `warning: browser-input is still v${now || '?'} after the update (expected v${EXPECTED_DRIVER_VERSION}). ` +
      `The OS executor will run, but recent input fixes may be missing. ` +
      `Rebuild from source: bash ${path.relative(ROOT, BUILD_SCRIPT)}`
    );
  }
}

async function installDriver(binPath) {
  if (process.platform === 'linux') {
    // No prebuilt Linux asset is published (downloadDriver only fetches the
    // notarized macOS binary), so build from source. build.sh verifies gcc and
    // the X11 dev headers and prints distro-specific install hints if they're
    // missing; buildDriver() surfaces that as a clean PreflightError.
    log('browser-input (the Linux X11 input driver) is not installed — building from source...');
    buildDriver();
    return;
  }

  if (process.platform !== 'darwin') {
    throw new PreflightError(
      `The OS executor requires macOS or Linux (X11); ${process.platform} is unsupported. Use --executor cdp.`
    );
  }

  const choice = await choose(
    'browser-input (the macOS input driver) is not installed. How would you like to install it?',
    [
      { label: 'Download notarized binary from GitHub releases  (recommended)', value: 'download' },
      { label: 'Build from source  (requires Xcode CLI tools: xcode-select --install)', value: 'build' },
    ]
  );

  if (choice.value === 'download') {
    await downloadDriver();
  } else {
    buildDriver();
  }
}

async function ensureDriver(binPath) {
  if (fs.existsSync(binPath)) {
    // Already installed — make sure it isn't a stale build from before a driver
    // update (git pull refreshes the source but never the ignored binary).
    await ensureDriverCurrent(binPath);
    return;
  }
  await installDriver(binPath);
}

// ── Step 3 — OS input available (macOS Accessibility / Linux X11) ────────────

async function requestAxPrompt(binPath) {
  if (process.platform !== 'darwin') return;
  await helperOneShot(binPath, { op: 'axprompt' });
  try {
    execFileSync('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
  } catch {}
}

async function ensureInputTrusted(binPath) {
  log('checking OS-level input is available...');
  const trusted = await probeAxTrusted(binPath);
  if (trusted) return;

  if (process.platform === 'linux') {
    // On Linux the helper reports trusted:false when it can't inject input —
    // either a native Wayland session (XTEST is a no-op there) or no reachable
    // X display at all (DISPLAY unset / no X server, e.g. a headless box).
    throw new PreflightError(
      'OS-level input is not available.\n' +
      'The os executor injects input through X11/XTEST, which needs a reachable X\n' +
      'display (Xorg or Xwayland). Common causes:\n\n' +
      '  - a native Wayland session — XTEST is a no-op there\n' +
      '  - no X server / DISPLAY not set (e.g. a headless or SSH session)\n\n' +
      'Fix: run inside an Xorg or Xwayland session, or switch to CDP: --executor cdp'
    );
  }

  await requestAxPrompt(binPath);
  if (process.stdin.isTTY) {
    process.stderr.write(
      '\n[preflight] macOS Accessibility permission is required before the OS executor can run.\n' +
      'Grant access in System Settings, then press Enter to continue.\n'
    );
    await prompt('> ');
    if (await probeAxTrusted(binPath)) return;
  }

  throw new PreflightError(
    'Accessibility permission is not granted.\n' +
    'The OS executor drives the real cursor/keyboard and macOS blocks that until\n' +
    'you allow it:\n\n' +
    '  System Settings → Privacy & Security → Accessibility\n' +
    '  → enable Terminal (or whichever app runs Node)\n\n' +
    'Then re-run. (Or switch to CDP: --executor cdp)'
  );
}

// Spawn the helper, send one command, resolve its `data` object (or null on any
// failure/timeout), then tear the child down. For one-shot probes from preflight
// — the long-lived client lives in the executor, not here.
function helperOneShot(binPath, cmd, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(binPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return finish(null); }
    let buf = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
    child.stdout.on('data', d => {
      buf += d.toString();
      // Scan every complete line, not just the first: if the helper ever prints a
      // log/warning line before its JSON reply, parsing only line 1 would mis-read
      // it as a failure (and abort preflight). Stop at the first line that parses.
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let resp;
        try { resp = JSON.parse(line); } catch { continue; }   // not JSON — keep scanning
        clearTimeout(timer);
        finish(resp.ok === true ? (resp.data || {}) : null);
        try { child.kill(); } catch {}
        return;
      }
    });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.stdin.write(JSON.stringify({ id: 'pf', ...cmd }) + '\n');
  });
}

async function probeAxTrusted(binPath) {
  const data = await helperOneShot(binPath, { op: 'axtrusted' });
  return data?.trusted === true;
}

// ── Step 6 — foreground the agent's Chrome ────────────────────────────────────

// The OS executor only sends input while Chrome is the frontmost app. When a run
// reuses an already-running Chrome (or launches one that doesn't grab focus),
// the loop would otherwise sit paused until the user manually clicks the window.
// Bring it forward for them. PID-targeted (not `open -a "Google Chrome"`) so we
// foreground the browser-agent instance specifically, never a personal Chrome that
// happens to share the app bundle. Best-effort: any failure just falls back to
// the executor's existing wait-for-frontmost behavior.
async function raiseChrome(binPath) {
  const pid = mainChromePid(DEFAULT_PROFILE_DIR);
  if (!pid) return;   // nothing on the browser-agent profile to raise (e.g. a different Chrome owns the port)
  const data = await helperOneShot(binPath, { op: 'raise', pid: Number(pid) });
  if (data?.raised) log('brought the browser-agent Chrome window to the foreground.');
}

// ── Step 4 — provider credentials ────────────────────────────────────────────

function readEnvFile() {
  try { return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''; } catch { return ''; }
}

function writeKeyToEnvFile(keyName, value) {
  let contents = readEnvFile();
  const re = new RegExp(`^${keyName}=.*$`, 'm');
  if (re.test(contents)) {
    contents = contents.replace(re, `${keyName}=${value}`);
  } else {
    contents = contents.trimEnd() + `\n${keyName}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, contents);
}

// True if `keyName` already has a value, either exported in the shell or
// written (non-blank) in .env. Used to decide whether a key still needs asking.
function keyPresent(keyName) {
  if (process.env[keyName]) return true;
  const m = readEnvFile().match(new RegExp(`^${keyName}=(.+)$`, 'm'));
  return !!(m && m[1].trim().replace(/^["']|["']$/g, ''));
}

// First-run convenience: offer to collect all three provider API keys up front,
// each optional. Runs only on a clean slate (no provider key configured yet)
// and only when interactive — otherwise a no-op, leaving the per-provider
// ensureCreds() below to enforce whatever the run actually needs. Pressing
// Enter skips a key, leaving it blank in .env; ensureCreds() insists later only
// if that skipped provider turns out to be the one in use.
async function setupCreds() {
  if (!process.stdin.isTTY) return;
  // If any key is already set, the user has configured before — don't re-prompt
  // the whole set; ensureCreds() handles topping up whatever's still missing.
  if (SETUP_PROVIDERS.some(p => keyPresent(p.keyName))) return;

  process.stderr.write(
    `\n[preflight] Set up your provider API keys.\n` +
    `  Paste a key for each provider you want to use, or press Enter to skip.\n` +
    `  You can add or change these any time in .env.\n`
  );
  for (const { keyName, label } of SETUP_PROVIDERS) {
    const key = await promptHidden(`  ${label} (${keyName}) — paste key or Enter to skip: `);
    if (!key) continue;
    writeKeyToEnvFile(keyName, key);
    process.env[keyName] = key;
    log(`${keyName} saved to .env.`);
  }
}

async function ensureCreds(provider) {
  if (provider === 'ollama') return;
  const keyName = KEY_FOR[provider];
  if (!keyName) return;

  if (process.env[keyName]) {
    // Warn if shell env is shadowing a different value in .env — a stale
    // exported key otherwise keeps winning even after .env is updated.
    const fileContents = readEnvFile();
    const match = fileContents.match(new RegExp(`^${keyName}=(.+)$`, 'm'));
    if (match) {
      const fileVal = match[1].trim().replace(/^["']|["']$/g, '');
      if (fileVal && fileVal !== process.env[keyName]) {
        process.stderr.write(
          `[preflight] Warning: ${keyName} in your shell differs from .env.\n` +
          `  Shell value is being used — run \`unset ${keyName}\` if you want .env to win.\n`
        );
      }
    }
    return;
  }

  // Key not in environment at all — prompt and save.
  process.stderr.write(`\n[preflight] ${keyName} is not set.\n`);
  const key = await promptHidden(`  Enter your ${provider} API key: `);
  if (!key) throw new PreflightError(`${keyName} is required. Add it to .env and retry.`);

  writeKeyToEnvFile(keyName, key);
  process.env[keyName] = key;
  log(`${keyName} saved to .env.`);
}

// ── Step 5 — Chrome ───────────────────────────────────────────────────────────

// Returns the debug port browser-agent should actually connect to. launch()
// owns the reuse rules: prefer an existing browser-agent profile, restart only
// that profile if stale, and choose a free port when the preferred one is busy.
async function ensureChrome(port, chrome) {
  const resolvedPort = await launch({ port, executablePath: chrome?.executablePath });
  if (resolvedPort !== port) log(`using browser-agent Chrome on port ${resolvedPort}.`);
  return resolvedPort;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function preflight({ config, port = 9222 } = {}) {
  ensureEnvFile();
  ensureDeps();

  const isOs = config.executor?.backend === 'os';
  const binPath = config.executor?.binPath || BIN_PATH;
  if (isOs) {
    await ensureDriver(binPath);
    await ensureInputTrusted(binPath);
  }

  // Each model role may use a different provider; ensure creds for every distinct
  // provider that will actually run (skip disabled reflect/report).
  await setupCreds();
  const roles = config.models || {};
  const need = new Set([roles.primary?.provider, roles.vision?.provider].filter(Boolean));
  if (roles.reflect?.enabled !== false && roles.reflect?.provider) need.add(roles.reflect.provider);
  if (roles.report?.enabled !== false && roles.report?.provider) need.add(roles.report.provider);
  for (const p of need) await ensureCreds(p);
  const resolvedPort = await ensureChrome(port, config.chrome);

  // Only meaningful for the os backend (cdp drives input over the wire and needs
  // no foreground); opt out via executor.raiseChromeOnStart: false.
  if (isOs && config.executor?.raiseChromeOnStart !== false) {
    await raiseChrome(binPath);
  }

  log('ready.');
  return resolvedPort;
}

module.exports = { preflight, PreflightError };
