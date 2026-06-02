export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  contentWidth?: number | null;
  contentHeight?: number | null;
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** [x, y, width, height] rounded to integers — used in tree and lean modes. */
export type BBoxArray = [number, number, number, number];

export interface ComputedStyle {
  cursor: string | null;
  display: string | null;
  visibility: string | null;
  opacity: string | null;
  'pointer-events': string | null;
  position: string | null;
  'z-index': string | null;
  'background-color': string | null;
  'background-image': string | null;
  'background-repeat': string | null;
  color: string | null;
  'font-size': string | null;
  'font-weight': string | null;
  'border-radius': string | null;
  overflow: string | null;
}

// ─── Full / lean mode ────────────────────────────────────────────────────────

/**
 * Stable reference assigned at extract time. Format: `@<type><n>` where
 * `<type>` is `e` (interactive element), `t` (text node), `r` (unreadable
 * region). Stable within a single snapshot only — a new extraction reassigns.
 * Regex: `/^@[etr]\d+$/`.
 */
export type ElementRef = string;
export type TextRef = string;
export type RegionRef = string;
export type SnapshotRef = ElementRef | TextRef | RegionRef;

/** Maps each `ref` to its CDP `backendNodeId` for the current session. */
export type RefLookup = Record<SnapshotRef, number>;

export interface FullElement {
  ref: ElementRef;
  role: string | null;
  name: string | null;
  source: 'role' | 'focusable';
  focusable: boolean | null;
  expanded: boolean | null;
  checked: boolean | 'mixed' | null;
  selected: boolean | null;
  /** AX `haspopup` token (e.g. `"menu"`, `"dialog"`), or null. */
  haspopup: string | null;
  required: boolean | null;
  /** AX `invalid` token: `"false"` | `"true"` | `"grammar"` | `"spelling"`. */
  invalid: string | null;
  disabled: boolean | null;
  url: string | null;
  bbox: BBox | null;
  inViewport: boolean;
  computedStyle: ComputedStyle | null;
}

export interface LeanElement {
  ref: ElementRef;
  role: string | null;
  name: string | null;
  bbox: BBox | null;
  inViewport: boolean;
  value?: string;
  url?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  /** Set when the control opens a popup: "menu" | "listbox" | "tree" | "grid" | "dialog" | "true". */
  haspopup?: string;
  required?: true;
  /** Present (and `true`) only when the field failed validation. */
  invalid?: true;
  disabled?: true;
}

export interface TextNode {
  ref: TextRef;
  role: string | null;
  name: string;
  level: number | null;
  bbox: BBox | null;
  inViewport: boolean;
}

export interface RegionNode {
  ref: RegionRef;
  role: 'canvas' | 'image' | 'svg' | 'iframe' | string;
  bbox: BBox;
  inViewport: boolean;
}

export interface FlatStats {
  totalAXNodes: number;
  interactiveFound: number;
  textFound: number;
  withBounds: number;
  inViewport: number;
  returned: number;
  regionsReturned?: number;
  elapsedMs: number;
}

export interface FlatResult {
  schemaVersion: '2.0';
  url: string;
  title: string;
  timestamp: string;
  viewport: Viewport;
  elements: FullElement[] | LeanElement[];
  text: TextNode[];
  regions: RegionNode[];
  lookup: RefLookup;
  stats: FlatStats;
}

// ─── Tree mode ───────────────────────────────────────────────────────────────

export interface TreeInteractiveNode {
  ref: ElementRef;
  role: string;
  name?: string;
  bbox: BBoxArray;
  inViewport?: true;
  value?: string;
  url?: string;
  checked?: boolean | 'mixed';
  selected?: boolean;
  expanded?: boolean;
  /** Set when the control opens a popup: "menu" | "listbox" | "tree" | "grid" | "dialog" | "true". */
  haspopup?: string;
  required?: true;
  /** Present (and `true`) only when the field failed validation. */
  invalid?: true;
  disabled?: true;
}

export interface TreeTextNode {
  ref: ElementRef;
  role: string;
  name: string;
  bbox?: BBoxArray;
  inViewport?: true;
  level?: number;
}

export interface TreeContainerNode {
  role: string;
  name?: string;
  children: TreeNode[];
}

export type TreeNode = TreeInteractiveNode | TreeTextNode | TreeContainerNode;

export interface TreeStats {
  totalAXNodes: number;
  interactiveReturned: number;
  textReturned: number;
  elapsedMs: number;
}

export interface TreeResult {
  schemaVersion: '2.0';
  url: string;
  title: string;
  timestamp: string;
  viewport: Viewport;
  tree: TreeContainerNode | null;
  lookup: RefLookup;
  stats: TreeStats;
}

export type ExtractionResult = FlatResult | TreeResult;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** CDP debugging port. Default: 9222 */
  port?: number;
  /** Output format. Default: 'full' */
  format?: 'tree' | 'lean' | 'full';
  /** Only return elements whose bbox intersects the current viewport. Default: false */
  inViewportOnly?: boolean;
  /** Auto-launch Chrome if not already running. Default: false */
  launch?: boolean;
  /** Substring to match against tab URLs when selecting which tab to use. */
  url?: string;
  /** Override default interactive role set. */
  interactiveRoles?: string[];
  /** Override default container role set (tree mode only). */
  containerRoles?: string[];
}

export interface LaunchOptions {
  /** CDP debugging port. Default: 9222 */
  port?: number;
  /** Explicit path to Chrome/Chromium executable. Defaults to BROWSER_AGENT_CHROME_PATH or auto-discovery. */
  executablePath?: string;
  /** Chrome user data directory. Default: ~/.browser-agent/profile */
  userDataDir?: string;
  /** Launch Chrome in headless mode. Default: false */
  headless?: boolean;
  /** Maximum ms to wait for Chrome to become ready. Default: 10000 */
  timeout?: number;
  /** Additional Chrome CLI flags. */
  extraArgs?: string[];
}

// ─── Session ─────────────────────────────────────────────────────────────────

export declare class Session {
  /** Raw CDP client for direct protocol access. */
  readonly client: object;
  extract(opts?: ExtractOptions): Promise<ExtractionResult>;
  close(): Promise<void>;
}

// ─── Executor config ─────────────────────────────────────────────────────────

export interface HumanizeOptions {
  /** Master switch. Default: true for `os` backend, ignored by `cdp`. */
  enabled?: boolean;
  /** Cursor travel speed in CSS pixels per second. Default: 1400. */
  mouseSpeedPxPerSec?: number;
  /** Max ± per-frame deviation from the Bezier path, in pixels. Default: 2. */
  mouseJitterPx?: number;
  /** Per-keystroke delay min (ms). Default: 25. */
  keystrokeDelayMsMin?: number;
  /** Per-keystroke delay max (ms). Default: 85. */
  keystrokeDelayMsMax?: number;
  /** Pause after arrival, before mouseDown (ms). Default min/max: 40/160. */
  preClickPauseMsMin?: number;
  preClickPauseMsMax?: number;
  /** Pause after focus before typing (ms). Default: 80. */
  postFocusPauseMs?: number;
  /** Pause after clearing a field before typing replacement text (ms). Default: 50. */
  postClearPauseMs?: number;
}

export interface ExecutorOptions {
  /** Backend selection. Default: env BROWSER_AGENT_EXECUTOR or 'os'. */
  backend?: 'cdp' | 'os';
  /** Override path to the browser-input binary (os backend, macOS only). */
  binPath?: string;
  /** Pause OS input while the human uses mouse/keyboard. Default: true. */
  pauseOnUserInput?: boolean;
  /** Resume OS input only after the human is idle this long. Default: 600. */
  userIdleMs?: number;
  /** Foreground the agent Chrome at run start for the OS backend. Default: true. */
  raiseChromeOnStart?: boolean;
  /** Humanlike motion / timing knobs. Only meaningful for the `os` backend. */
  humanize?: HumanizeOptions;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/** Open a persistent CDP session. Reuse for multiple extract() calls. */
export declare function connect(opts?: ExtractOptions & LaunchOptions): Promise<Session>;

/** One-shot: connect, extract, disconnect. */
export declare function extract(opts?: ExtractOptions & LaunchOptions): Promise<ExtractionResult>;

/** Launch or reuse the isolated Chrome profile and return its CDP debugging port. */
export declare function launch(opts?: LaunchOptions): Promise<number>;

/** Check if Chrome is already listening on the given port. */
export declare function isRunning(port?: number): Promise<boolean>;
