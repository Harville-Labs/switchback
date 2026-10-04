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

/**
 * A fixed key, or a function returning a current token (Microsoft Entra ID).
 * The OpenAI SDK calls the function before each request.
 */
export type ApiKeySource = string | (() => Promise<string>);

export interface HealthStatus {
  ok: boolean;
  detail: string;
  latencyMs?: number;
  /** Model IDs the server lists, when the health check fetched them. */
  models?: string[];
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
  /**
   * Place `text` on an ordered rubric, for decision models that answer typed
   * questions instead of chatting (TypeSafe Jev). Providers with `rate` and
   * `decisionOnly` can't `stream`.
   */
  rate?(request: RateRequest): Promise<RateResult>;
  /** True for providers that only answer `rate`; config keeps them out of chat roles. */
  readonly decisionOnly?: boolean;
}

export interface RateRequest {
  model: string;
  /** The question. */
  instructions: string;
  /** Rubric levels from low to high, at least two. */
  levels: readonly [string, string, ...string[]];
  /** What is being rated. */
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RateResult {
  /** Index into `levels`: the expected score, rounded. */
  level: number;
  /** Probability-weighted score, from 0 to `levels.length - 1`. */
  score: number;
  /** 0 to 1; 1 when the probability sits on one level. */
  confidence: number;
  usage: Usage;
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
