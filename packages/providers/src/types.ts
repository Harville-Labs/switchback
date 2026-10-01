import type { Message, Part, StopReason, Tier, Usage } from '@switchback/protocol';

/** JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** `none` asks the model not to think at all (quick classification, simple edits). */
export type Effort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: Effort;
  signal?: AbortSignal;
}

/**
 * Streaming events from a provider. Deltas are for display only; the `done`
 * event carries the canonical parts that the engine appends to the transcript.
 */
export type ChatEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | {
      type: 'done';
      parts: Part[];
      usage: Usage;
      stopReason: StopReason;
      /** The model that produced the result, when a provider-side fallback swapped it. */
      model?: string;
    };

export interface HealthStatus {
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export interface Provider {
  readonly id: string;
  readonly tier: Tier;
  /** Cheap reachability check. Local providers are probed before routing to them. */
  health(signal?: AbortSignal): Promise<HealthStatus>;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
  /** The context window the server loads for `model`, when it can tell. */
  contextWindow?(model: string): Promise<{ contextWindow: number; source: string } | undefined>;
  /**
   * Exact token count of `text` with the model's own tokenizer, when the
   * server offers one. Undefined means "can't say"; callers fall back to an
   * estimate.
   */
  countTokens?(model: string, text: string, signal?: AbortSignal): Promise<number | undefined>;
}

/** Thrown for failures the router may recover from by falling back to another model. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }
}
