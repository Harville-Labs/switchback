/**
 * Adapter for Chat Completions APIs. It serves three kinds of provider:
 *
 * - local servers (Ollama, llama.cpp, LM Studio, vLLM, MLX), flavor `generic`
 * - OpenAI, flavor `openai`: `max_completion_tokens`, `reasoning_effort`
 * - DeepSeek, flavor `deepseek`: thinking mode, and reasoning replayed to the
 *   same model on later turns (the API rejects tool-call histories without it)
 *
 * - OpenRouter, flavor `openrouter`: its `reasoning` parameter
 *
 * plus any other hosted OpenAI-compatible API (Together, Groq, Fireworks, ...)
 * as `generic` with `tier: remote`.
 *
 * Gateways such as OpenRouter stream structured `reasoning_details` (Claude
 * thinking signatures, Gemini thought signatures, encrypted OpenAI reasoning)
 * and need them back unchanged on later tool-call turns. They're kept as the
 * reasoning part's opaque payload and replayed only to the model that made them.
 */
import type { ModelRef, Part, StopReason, Tier, Usage } from '@switchback/protocol';
import OpenAI from 'openai';
import { probeContextWindow } from './local-detect.ts';
import {
  type ChatEvent,
  type ChatRequest,
  type Effort,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export type ChatFlavor = 'generic' | 'openai' | 'deepseek' | 'openrouter';

/** The flavor for an OpenAI-compatible base URL that isn't one of the named providers. */
export function flavorForUrl(baseUrl: string): ChatFlavor {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter' : 'generic';
  } catch {
    return 'generic';
  }
}

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  tier: Tier;
  flavor?: ChatFlavor;
  /** Shown when a hosted provider has no key, e.g. "set OPENAI_API_KEY". */
  missingKeyHint?: string;
  headers?: Record<string, string>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      reasoning_details?: unknown[];
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Structured reasoning from a gateway, kept on `ReasoningPart.opaque`. */
interface ReasoningOpaque {
  reasoningDetails?: unknown[];
}

/**
 * Translate the neutral transcript. Only reasoning that `model` produced is
 * ever sent back: its `reasoning_details` always (gateways need them on tool-call
 * turns), and its text as `reasoning_content` only when `replayText` is set
 * (DeepSeek).
 */
export function toWireMessages(
  system: string,
  messages: ChatRequest['messages'],
  model?: ModelRef,
  replayText = false,
): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      // Tool results become `tool` messages; plain text becomes a user message.
      const text: string[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          const content = p.isError ? `Error: ${p.content}` : p.content;
          out.push({ role: 'tool', tool_call_id: p.callId, content });
        } else if (p.type === 'text') {
          text.push(p.text);
        }
      }
      if (text.length) out.push({ role: 'user', content: text.join('\n') });
    } else {
      const text = m.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const own = m.parts.flatMap((p) =>
        p.type === 'reasoning' &&
        model &&
        p.origin.provider === model.provider &&
        p.origin.model === model.model
          ? [p]
          : [],
      );
      const reasoning = replayText ? own.map((p) => p.text).join('') : '';
      const details = own.flatMap(
        (p) => (p.opaque as ReasoningOpaque | undefined)?.reasoningDetails ?? [],
      );
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(details.length ? { reasoning_details: details } : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

/** DeepSeek accepts low/high/max. */
const DEEPSEEK_EFFORT = {
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'max',
  max: 'max',
} as const;

/**
 * Reasoning controls per flavor. `none` turns thinking off: DeepSeek by not
 * enabling it, OpenAI with `reasoning_effort: "none"`, and local servers with
 * both `reasoning_effort: "none"` (Ollama) and the chat-template switch that
 * vLLM, llama.cpp, and SGLang pass to thinking models such as Qwen3.
 */
export function effortParams(
  flavor: ChatFlavor,
  effort: Effort | undefined,
): Record<string, unknown> {
  if (!effort) return {};
  if (flavor === 'deepseek')
    return effort === 'none'
      ? {}
      : { reasoning_effort: DEEPSEEK_EFFORT[effort], thinking: { type: 'enabled' } };
  // OpenRouter's unified parameter, which it translates for each upstream model.
  if (flavor === 'openrouter') return { reasoning: { effort } };
  if (flavor === 'generic') {
    if (effort === 'none')
      return { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
    // Local servers (Ollama in particular) accept only low/medium/high.
    return { reasoning_effort: effort === 'xhigh' || effort === 'max' ? 'high' : effort };
  }
  return { reasoning_effort: effort };
}

/**
 * Normalize usage so `inputTokens` excludes cache hits, matching how cost is
 * computed (cache reads are priced separately).
 */
export function normalizeUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek's name for cached input. */
  prompt_cache_hit_tokens?: number;
}): Usage {
  const prompt = u.prompt_tokens ?? 0;
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

const STOP_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

/**
 * Error codes that mean "try again or elsewhere" when a gateway reports a
 * failure inside an already-successful (HTTP 200) stream.
 */
const RETRYABLE_STREAM_CODES = new Set(['server_error', 'rate_limit_exceeded', 'timeout']);

/** Merge streamed `reasoning_details` fragments: same type and index continue one detail. */
export function appendReasoningDetails(into: Record<string, unknown>[], chunk: unknown[]): void {
  for (const raw of chunk) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const last = into.at(-1);
    if (last && d.index !== undefined && last.index === d.index && last.type === d.type) {
      for (const key of ['text', 'summary', 'data'] as const)
        if (typeof d[key] === 'string') last[key] = `${(last[key] as string) ?? ''}${d[key]}`;
      for (const [k, v] of Object.entries(d))
        if (!['text', 'summary', 'data'].includes(k) && v !== undefined && v !== null) last[k] = v;
    } else {
      into.push({ ...d });
    }
  }
}

/** Retryable: connection failures, timeouts, rate limits, and server errors. */
function toProviderError(err: unknown, id: string): ProviderError {
  if (err instanceof OpenAI.APIConnectionError)
    return new ProviderError(`${id} is unreachable: ${err.message}`, id, true, { cause: err });
  if (err instanceof OpenAI.APIError && err.status === undefined) {
    // An error event inside a 200 stream (OpenRouter and other gateways).
    const code = (err.error as { code?: unknown } | undefined)?.code;
    const retryable =
      typeof code === 'number'
        ? code === 408 || code === 429 || code >= 500
        : RETRYABLE_STREAM_CODES.has(String(code));
    return new ProviderError(
      `${id} failed mid-stream: ${err.message.slice(0, 500)}`,
      id,
      retryable,
      {
        cause: err,
      },
    );
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status ?? 0;
    return new ProviderError(
      `HTTP ${status} from ${id}: ${err.message.slice(0, 500)}`,
      id,
      status === 408 || status === 429 || status >= 500,
      { cause: err },
    );
  }
  return new ProviderError(`${id} failed: ${(err as Error).message}`, id, false, { cause: err });
}

/** Extra wire fields the SDK's types don't declare (DeepSeek, Ollama, vLLM). */
type Delta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
  /** OpenRouter's structured reasoning, needed back on later tool-call turns. */
  reasoning_details?: unknown[] | null;
};

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly tier: Tier;
  private readonly baseUrl: string;
  private readonly client: OpenAI;
  /** Which `/tokenize` request shape this server accepts, once known. */
  private tokenizer: 'llama.cpp' | 'vllm' | 'none' | undefined;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.tier = options.tier;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.client = new OpenAI({
      baseURL: this.baseUrl,
      // Every option is explicit so the SDK never picks up OPENAI_* variables
      // from the environment and sends an OpenAI key to some other server.
      // Keyless local servers get no Authorization header at all.
      apiKey: options.apiKey ?? 'unused',
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      defaultHeaders: { ...(options.apiKey ? {} : { Authorization: null }), ...options.headers },
      // Local servers fail fast so the router can fall back; hosted APIs get
      // the SDK's backoff for 429s and transient 5xx.
      maxRetries: options.tier === 'local' ? 0 : 2,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  private get flavor(): ChatFlavor {
    return this.options.flavor ?? 'generic';
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    if (this.tier === 'remote' && !this.options.apiKey && this.options.missingKeyHint) {
      return { ok: false, detail: `no API key (${this.options.missingKeyHint})` };
    }
    const started = performance.now();
    try {
      const page = await this.client.models.list({
        maxRetries: 0,
        timeout: 2000,
        ...(signal ? { signal } : {}),
      });
      return {
        ok: true,
        detail: `reachable at ${this.baseUrl}`,
        latencyMs: Math.round(performance.now() - started),
        models: page.data.map((m) => m.id),
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      if (err instanceof OpenAI.APIError && err.status)
        return { ok: false, detail: `HTTP ${err.status} from ${this.baseUrl}/models`, latencyMs };
      return { ok: false, detail: `unreachable at ${this.baseUrl}: ${(err as Error).message}` };
    }
  }

  /** What every request to this server carries: configured headers, then the key. */
  private authHeaders(): Record<string, string> {
    return {
      ...this.options.headers,
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }

  async contextWindow(model: string) {
    // Local servers can say what they load; hosted APIs are configured from the catalog.
    if (this.tier === 'remote') return undefined;
    return probeContextWindow(this.baseUrl, model, {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      // Servers started with an API key refuse even their info endpoints without it.
      headers: this.authHeaders(),
    });
  }

  /**
   * llama.cpp and vLLM expose `/tokenize` at the server root (not under /v1),
   * with different request shapes. Try each once and remember which works;
   * only a definite 404/405 marks the server as having none (Ollama, LM Studio).
   */
  async countTokens(model: string, text: string, signal?: AbortSignal) {
    if (this.tier === 'remote' || this.tokenizer === 'none') return undefined;
    const root = this.baseUrl.replace(/\/v1$/, '');
    const shapes = {
      'llama.cpp': { content: text, add_special: false },
      vllm: { model, prompt: text, add_special_tokens: false },
    } as const;
    const order = this.tokenizer ? [this.tokenizer] : (['llama.cpp', 'vllm'] as const);
    let definite = true;
    for (const dialect of order) {
      try {
        const res = await (this.options.fetch ?? fetch)(`${root}/tokenize`, {
          method: 'POST',
          headers: { ...this.authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify(shapes[dialect]),
          signal: signal ?? AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          if (res.status !== 404 && res.status !== 405 && res.status !== 400 && res.status !== 422)
            definite = false;
          continue;
        }
        const body = (await res.json()) as { count?: number; tokens?: unknown[] };
        const n = typeof body.count === 'number' ? body.count : body.tokens?.length;
        if (typeof n === 'number' && (n > 0 || !text)) {
          this.tokenizer = dialect;
          return n;
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        definite = false;
      }
    }
    if (definite && !this.tokenizer) this.tokenizer = 'none';
    return undefined;
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const flavor = this.flavor;
    const origin: ModelRef = { provider: this.id, model: request.model };
    const effort = request.effort;
    // Built loosely typed: DeepSeek's `thinking` and replayed `reasoning_content`
    // aren't in the SDK's types, and the SDK sends the body as given.
    const body = {
      model: request.model,
      stream: true as const,
      stream_options: { include_usage: true },
      // OpenAI's reasoning models reject max_tokens.
      ...(flavor === 'openai'
        ? { max_completion_tokens: request.maxTokens }
        : { max_tokens: request.maxTokens }),
      ...effortParams(flavor, effort),
      messages: toWireMessages(request.system, request.messages, origin, flavor === 'deepseek'),
      ...(request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

    let text = '';
    let reasoningText = '';
    const reasoningDetails: Record<string, unknown>[] = [];
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;

    try {
      const stream = await this.client.chat.completions.create(body, {
        ...(request.signal ? { signal: request.signal } : {}),
      });
      for await (const chunk of stream) {
        if (chunk.usage) usage = normalizeUsage(chunk.usage);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = (choice.delta ?? {}) as Delta;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) {
          reasoningText += reasoning;
          yield { type: 'reasoning.delta', text: reasoning };
        }
        if (delta.reasoning_details?.length)
          appendReasoningDetails(reasoningDetails, delta.reasoning_details);
        if (delta.content) {
          text += delta.content;
          yield { type: 'text.delta', text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const existing = calls.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          calls.set(tc.index, existing);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw toProviderError(err, this.id);
    }

    if (finish === 'error')
      // A gateway ended the stream on an upstream failure without an error payload.
      throw new ProviderError(`${this.id} ended the response with an error`, this.id, true);

    const parts: Part[] = [];
    // Kept in the transcript with its origin; replayed only to this model.
    if (reasoningText || reasoningDetails.length)
      parts.push({
        type: 'reasoning',
        text: reasoningText,
        origin,
        ...(reasoningDetails.length
          ? { opaque: { reasoningDetails } satisfies ReasoningOpaque }
          : {}),
      });
    if (text) parts.push({ type: 'text', text });
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown;
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        // Surface malformed arguments to the engine so it can count them as an
        // escalation signal instead of silently running a tool on garbage.
        input = { __malformed: call.args };
      }
      parts.push({
        type: 'tool_call',
        id: call.id || `call_${index}_${crypto.randomUUID().slice(0, 8)}`,
        name: call.name,
        input,
      });
    }
    const stopReason: StopReason =
      calls.size > 0 ? 'tool_use' : (STOP_MAP[finish ?? 'stop'] ?? 'end_turn');
    yield { type: 'done', parts, usage, stopReason };
  }
}
