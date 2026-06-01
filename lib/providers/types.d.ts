// Advisory type definitions for the provider adapter layer.
//
// These types are NOT compiled and NOT required to run browser-agent. They exist
// so editors and an optional `tsc --checkJs` pass can verify that each provider
// in lib/providers/*.js conforms to the same contract. Every shape here mirrors
// a runtime shape that already exists in the code (see _shared.js buildCompletion,
// model.js toolsFromRegistry, loop.js callModel call site) — this file names them, it
// does not change them.
//
// See docs/model-adapters-spec.md § 3 and DESIGN.md § Providers.

/** OpenAI reasoning effort. Only the OpenAI Responses path consumes this today. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** A single tool definition as produced by model.js toolsFromRegistry(). */
export interface ToolDef {
  name: string;
  description: string;
  /** Generic schema map (e.g. { ref: 'string?', selector: 'string' }); each
   *  provider translates this into its own native tool schema. */
  inputSchema: Record<string, unknown>;
}

/** A conversation message. `content` is either a plain string or an array of
 *  provider-agnostic content blocks (text / tool_use / tool_result) that each
 *  adapter maps to its native wire shape. */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A decoded tool call the loop will execute. Mirrors what every provider's
 *  parse step emits. */
export interface Action {
  kind: 'action';
  verb: string;
  args: Record<string, unknown>;
  ref?: string;
  toolUseId?: string;
}

/** Token accounting. Fields are null when the provider doesn't report them. */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
}

/** The unified planning result. Produced by _shared.buildCompletion(); do not
 *  add fields here without updating that function. */
export interface Completion {
  kind: 'completion';
  version: '1.0';
  provider: string;
  model: string;
  raw: unknown;
  actions: Action[];
  text: string | null;
  refusal: string | null;
  usage: Usage;
  elapsedMs: number;
}

/** Request handed to adapter.callModel(). Built at the lib/loop.js callModel call site. */
export interface ModelRequest {
  system: string;
  tools: ToolDef[];
  messages: Message[];
  /** null → the adapter's defaultModel. */
  model: string | null;
  cacheKey?: string;
  reasoningEffort?: ReasoningEffort | null;
  /** Per-call output-token cap. Falls back to the adapter's own default. */
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Request handed to adapter.describe() (vision). Phase 5 unifies vision.js onto
 *  this; declared now so capabilities/typing are stable. */
export interface VisionRequest {
  model: string | null;
  prompt: string;
  imageBase64: string;
  mimeType: string;
  cacheKey?: string;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VisionResult {
  kind: 'vision';
  version: '1.0';
  provider: string;
  model: string;
  text: string;
  usage: Usage;
  elapsedMs: number;
}

/** What an adapter can do. The dispatch layer reads this to decide which
 *  request fields are meaningful (e.g. strip reasoningEffort when false) instead
 *  of letting them be silently dropped. */
export interface Capabilities {
  /** Honors ModelRequest.reasoningEffort (OpenAI Responses path only, today). */
  reasoningEffort: boolean;
  /** Implements describe() for image input. */
  vision: boolean;
  /** Native tool/function calling vs. text-emulated tool calls. */
  toolUse: 'native' | 'emulated';
  /** Prompt/context caching model exposed by the provider. */
  cache: 'none' | 'automatic' | 'explicit' | 'implicit+explicit';
}

/** The contract every file in lib/providers/ must satisfy. */
export interface Adapter {
  readonly name: string;
  readonly defaultModel: string;
  readonly defaultVisionModel?: string;
  readonly capabilities: Capabilities;
  callModel(req: ModelRequest): Promise<Completion>;
  describe?(req: VisionRequest): Promise<VisionResult>;
}
