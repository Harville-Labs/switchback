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

export type Part = TextPart | ReasoningPart | ToolCallPart | ToolResultPart | CompactionPart;

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
