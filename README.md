# Browser Agent

**Regular Chrome. Agent-grade perception. OS-level stealth.**

Agents are learning to browse the web. The web has already learned to spot them.

Most browser agents still choose one of three bad shapes:

- **Playwright / Puppeteer**: fast, capable, and loudly fingerprinted.
- **Screenshots every turn**: broadly visible, painfully slow, expensive.
- **Full DOM dumps**: cheap-ish, noisy, huge, and not what the user actually sees.

Browser Agent takes the fourth path.

It drives the Chrome binary you already have, reads the fully rendered page, and
rebuilds a compact agent-native map: controls, text, unreadable visual regions,
state, and scroll context. Not the raw DOM. Not a screenshot loop.
A small "toy DOM" made for reasoning and action.

The model gets the page like this:

```text
[@t7]   heading     "Trending JavaScript repositories"
[@e14]  link        "facebook / react"
[@t18]  StaticText  "The library for web and native user interfaces."
[@t23]  StaticText  "230,000"
[@t24]  StaticText  "174 stars today"
[@r2]   image       640x320 - unreadable; take_screenshot @r2 to read
```

Then it acts on refs. Click `@e14`. Read `@r2`. Save the PDF. Finish with a
task-specific Markdown report synthesized from saved evidence, plus an HTML copy.

No Playwright. No Puppeteer. No cloned browser runtime. No screenshot tax unless
pixels actually matter.

## Why It Matters

Modern sites do not need to "solve AI" to block browser agents. They just need
to notice the harness.

Headless hints. WebDriver flags. Synthetic input. Extension residue. Strange
timing. DOM mutation. Screenshot-heavy loops that are too slow to operate like a
person.

Browser Agent is built around a different threat model: use normal Chrome, avoid
page-visible automation, pass the model only the minimum rendered structure it
needs, and make every expensive action deliberate.

On macOS and Linux, the default `os` executor sends input through the OS's own
trusted input path — `CGEventPost` on macOS, XTEST on Linux — the same channel
used by real mouse and keyboard hardware. It humanizes movement and typing,
refuses to type into the wrong foreground app, and pauses while you use the
machine.

From the site's side, the important parts look boring:

- real Chrome
- trusted click and key events
- no `navigator.webdriver`
- no Playwright or Puppeteer runtime
- no DOM dump sent to the model
- no per-turn screenshot loop

No anti-detection claim is absolute. But the macOS path removes the common
browser-automation fingerprints that make agent traffic easy to classify.

## What Is Fast

Browser Agent is fast because it does less.

- **Rendered-page extraction**: accessibility + layout channels become a compact
  text view in hundreds of milliseconds.
- **Tiny prompts**: the model sees refs, labels, state, and compact visual notes,
  not a full DOM or image every turn.
- **Prompt-cache friendly**: stable system/tool prefixes; terminal output shows
  cache percentage as the run warms.
- **No-change polling**: if the page has not changed, it waits and rechecks
  instead of burning another LLM call.
- **Targeted vision**: opaque regions can be cropped and classified before the
  planner sees them; explicit screenshot actions still target specific refs.

That is why Browser Agent is designed to be one of the most token-efficient browser
agents you can run.

Run the benchmark harness:

```bash
npm run launch
npm run bench
```

It runs a fixed task suite and prints a Markdown-friendly table with `Steps`,
`Time`, `In`, `Out`, `Cache%`, and `Pass`. Use that table to compare models,
providers, executor modes, and competing browser approaches.

## What It Can Do

Browser Agent is not just a clicker.

- navigate, click, type, press, scroll, wait, go back
- follow popups and new tabs when the browser opens them
- hit-test clicks and avoid obvious covered targets
- read text without selecting the whole page
- detect canvas/image/svg/CSS-background/cross-origin iframe regions the text tree cannot read
- screenshot the viewport or crop exactly to a ref
- list downloadable files without page JS
- save real bytes from loaded resources when possible
- save text snippets, promoted images, PDFs, docs, and archives to disk
- return a complete Markdown report and browser-readable HTML copy

Every run gets a workspace:

```text
runs/<run-id>/
  report.md
  report.html
  saved-manifest.json
  assets/
    screenshot-1.jpg
    product-sheet.pdf
    hero-image.png
```

The model can keep working without stuffing all of that back into context.
Text evidence and asset metadata go into the manifest; binary files go into
`assets/`.

## Try It

Prerequisites:

- Node.js 18 or newer
- Google Chrome or Chromium
- one provider key, unless you use `--provider ollama`

```bash
git clone https://github.com/taylorbayouth/browser-agent.git
cd browser-agent
npm install
```

Run a task:

```bash
node agent.js "Go to github.com/trending/javascript?since=daily. \
Collect the first 5 repositories with owner/name, description, total stars, \
and stars today. Return a compact markdown table."
```

`node agent.js` writes progress to stderr and one compact JSON handoff object to
stdout. The handoff includes the final Markdown plus absolute paths for
`report.md`, `report.html`, `saved-manifest.json`, assets, and logs, so another
agent should parse stdout and use the paths instead of inferring cwd.

The first run performs preflight:

- creates `.env` from `.env.example` if needed
- verifies dependencies are installed
- installs the `browser-input` helper for the default `os` executor
  - macOS: offers the notarized helper from GitHub Releases, or builds from
    source with Xcode command-line tools
  - Linux: builds the X11 helper from source
- checks OS input permission before the agent starts
  - macOS: requests Accessibility permission and opens the correct System
    Settings pane; grant access, then re-run if macOS has not reported it yet
  - Linux: verifies an X11/Xwayland display is reachable
- asks for the active provider API key and stores it in `.env`
- launches regular Chrome with an isolated Browser Agent profile at
  `~/.browser-agent/profile`

The native helper binary is not committed to git; `native/*/browser-input/bin/`
is a local build/download output. Published macOS builds belong on this repo's
GitHub Releases. If the release is missing or stale, choose the build-from-source
option on macOS:

```bash
xcode-select --install
bash native/macos/browser-input/build.sh
```

Each helper reports a build version (the `version` op), and the source carries a
matching `DRIVER_VERSION` (`native/macos/browser-input/main.swift`,
`native/linux/browser-input/main.c`) that preflight pins against. Because a
`git pull` updates the source but never the ignored binary, preflight checks the
installed helper's version on every run and refreshes an outdated one — rebuilding
from source where the toolchain is available (macOS with Xcode CLI tools, or
Linux), otherwise pulling the latest notarized macOS release. Bump
`DRIVER_VERSION` in both sources and `EXPECTED_DRIVER_VERSION` in
`lib/preflight.js` together whenever the helper's input behavior changes.

If Chrome is installed somewhere unusual, set its executable path explicitly:

```bash
BROWSER_AGENT_CHROME_PATH="/path/to/Google Chrome" node agent.js "..."
```

You can also set `chrome.executablePath` in `browser-agent.config.json`.

Want only the extractor?

```bash
npm run launch
node cli.js --lean --in-viewport-only --pretty
```

## Platform Story

Browser Agent has two execution lanes:

| Lane | Best for | Runs where | Detection profile |
|---|---|---|---|
| `os` | real sites, logged-in browsing, stealth runs | macOS, Linux (X11) | lowest: trusted OS input, humanized timing |
| `cdp` | CI, tests, local iteration | Chrome/Chromium via DevTools | higher: synthetic input |

The core extractor and agent loop are plain Node + Chrome DevTools Protocol.
The low-detection input backend runs on macOS (`CGEventPost`) and Linux
(`XTEST`). On Linux, Chrome must run as an X client (the default); launching
with `--ozone-platform=wayland` bypasses X11 and falls back to `cdp`.

## Providers

Browser Agent talks to providers through a small planning facade:

- OpenAI
- Anthropic
- Gemini
- Ollama

Defaults live in `browser-agent.config.json`. Environment variables override the
file; CLI flags override both.

Useful flags:

```bash
node agent.js --provider openai --model gpt-5.4-mini "..."
node agent.js --provider anthropic "..."
node agent.js --provider gemini --model gemini-3.1-pro "..."
node agent.js --provider ollama --model llama3.1 "..."
node agent.js --executor cdp "..."
node agent.js --context "Trusted operator context here" "..."
```

## How It Works

```text
Connect -> Extract -> Reduce -> Plan -> Validate -> Execute
   ^                                                     |
   +---------------- settle + re-snapshot ---------------+
```

The interesting part is the middle.

Browser Agent reconstructs a compact reasoning surface from the rendered browser:
accessible controls, readable text, layout boxes, state, scroll position, and
explicit "unreadable" regions for visual content. The model receives that small
map plus a minimal event history. It does not receive the full DOM. It does not
receive full-page screenshots as its default perception layer.

Actions are validated against the current snapshot before execution. Refs expire
after navigation. Files and promoted images are persisted before their summaries
go back into the loop. Repeated dead actions trip a stuck guard instead of running
forever.

Full contracts live in [`DESIGN.md`](DESIGN.md).

## Security And Trust

Browser Agent drives a browser from an LLM. Treat both the page and the model as
untrusted.

Guardrails today:

- dedicated Chrome profile at `~/.browser-agent/profile`
- page content is prompt data, not trusted instruction
- navigation and file saving reject privileged URL schemes
- perception, screenshots, image/file discovery, and resource reads do not rely
  on page JavaScript
- OS executor only sends input when Chrome is frontmost
- OS executor pauses while the human is actively using the machine
- `runs/` and `logs/` are local and git-ignored

Prompt injection is not solved. Do not hand an autonomous browser high-stakes
accounts and walk away.

## Contributing

Good places to push:

- Linux Wayland input backend (current `os` executor requires X11/Xwayland)
- stronger evals in `bench.js`
- more providers behind the existing planning facade
- better detector-facing measurements for humanized input
- deeper artifact extraction without growing prompt size

MIT.
