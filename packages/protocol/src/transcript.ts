/**
 * Provider-neutral conversation model.
 *
 * The engine stores every session as an append-only list of these messages and
 * translates to/from each provider's wire format at the edge. Nothing in this
 * file may depend on a specific provider.
 */

export type Tier = 'local' | 'remote';

/** A concrete model on a concrete provider, e.g. `{ provider: "ollama", model: "qwen3-coder:30b" }`. */
export interface ModelRef {
  provider: string;
  model: string;
}

export interface TextPart {
  type: 'text';
  text: string;
  /** Set when the engine attached a file the user @-mentioned; clients show a chip, not the text. */
  attachment?: { path: string };
  /** Set on the message that delivers a background subagent's report to its parent. */
  backgroundTask?: { sessionId: string; agent: string; ok: boolean };
  /** Why this part must never be sent to a remote model (see `privacy` in docs/configuration.md). */
  private?: string;
  /** Set on a reviewer's findings handed back to the model (docs/review.md). */
  review?: { round: number; model: ModelRef };
  /** Context the engine added for the model (e.g. that plan mode is on); clients don't show it. */
  reminder?: true;
  /**
   * Set on a reminder that delivers a changed AGENTS.md (ADR 0017): which
   * file, and its content hash (absent when the file was removed).
   */
  instructions?: { scope: 'user' | 'project'; hash?: string };
}

/** Image formats every vision-capable provider accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/**
 * The largest image, in bytes before base64: under the strictest provider's
 * limit (5 MB of base64), so an image that works with one model works with all.
 */
export const MAX_IMAGE_BYTES = 3_750_000;

/**
 * An image the user attached or a tool returned. Models without vision get a
 * text placeholder instead; the transcript keeps the image.
 */
export interface ImagePart {
  type: 'image';
  mediaType: ImageMediaType;
  /** Base64, no `data:` prefix. */
  data: string;
  /** Where it came from: a workspace path, or a name for a pasted image. */
  attachment?: { path: string };
  /** Why this image must never be sent to a remote model. */
  private?: string;
}

/**
 * Model reasoning. `origin` records the exact model that produced it: reasoning
 * blocks are only replayed to that same model (see docs/routing.md, "Switching
 * models mid-session") and are dropped when a turn is routed elsewhere.
 */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  origin: ModelRef;
  /** Opaque provider payload (e.g. an Anthropic thinking signature). Replayed verbatim. */
  opaque?: unknown;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: 'tool_result';
  callId: string;
  content: string;
  isError?: boolean;
  /** Why this result must never be sent to a remote model, e.g. `read secrets/prod.env`. */
  private?: string;
  /** Images the tool returned (`read` on an image file). */
  images?: ImagePart[];
}

/**
 * A compaction marker (ADR 0008). Appended as the only part of a user message;
 * never sent to a model. Requests are built from the latest marker: its
 * summary, then the messages from `keepFrom` onward.
 */
export interface CompactionPart {
  type: 'compaction';
  summary: string;
  /** Index of the first message kept verbatim (always an assistant message). */
  keepFrom: number;
  /** Prompt size before and after, for display. */
  tokensBefore: number;
  tokensAfter: number;
}

export type Part =
  | TextPart
  | ImagePart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | CompactionPart;

export interface Message {
  role: 'user' | 'assistant';
  parts: Part[];
  /** Set on assistant messages: which model produced the turn and why it was chosen. */
  meta?: { model: ModelRef; tier: Tier; routeReason?: string };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled' | 'error';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}

export function textOf(message: Message): string {
  return message.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
