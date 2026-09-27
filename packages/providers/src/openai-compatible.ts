/**
 * Adapter for Chat Completions APIs. It serves three kinds of provider:
 *
 * - local servers (Ollama, llama.cpp, LM Studio, vLLM, MLX), flavor `generic`
 * - OpenAI, flavor `openai`: `max_completion_tokens`, `reasoning_effort`
 * - DeepSeek, flavor `deepseek`: thinking mode, and reasoning replayed to the
 *   same model on later turns (the API rejects tool-call histories without it)
 *
 * plus any other hosted OpenAI-compatible API (OpenRouter, Together, Groq,
 * Fireworks, ...) as `generic` with `tier: remote`.
 */
import type { ModelRef, Part, StopReason, Tier, Usage } from '@harness/protocol';
import { probeContextWindow } from './local-detect.ts';
import {
  type ChatEvent,
  type ChatRequest,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export type ChatFlavor = 'generic' | 'openai' | 'deepseek';

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
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Translate the neutral transcript. Reasoning is sent back only when
 * `replayReasoningFor` is given, and only reasoning that model produced.
 */
export function toWireMessages(
  system: string,
  messages: ChatRequest['messages'],
  replayReasoningFor?: ModelRef,
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
      const reasoning = replayReasoningFor
        ? m.parts
            .filter(
              (p) =>
                p.type === 'reasoning' &&
                p.origin.provider === replayReasoningFor.provider &&
                p.origin.model === replayReasoningFor.model,
            )
            .map((p) => (p.type === 'reasoning' ? p.text : ''))
            .join('')
        : '';
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
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
 * Normalize usage so `inputTokens` excludes cache hits, matching how cost is
 * computed (cache reads are priced separately).
 */
export function normalizeUsage(u: {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
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

/** Parse a `text/event-stream` body into `data:` payloads. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trimStart();
}

const STOP_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
};

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly tier: Tier;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.tier = options.tier;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...this.options.headers,
    };
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
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: signal ?? AbortSignal.timeout(2000),
      });
      const latencyMs = Math.round(performance.now() - started);
      return res.ok
        ? { ok: true, detail: `reachable at ${this.baseUrl}`, latencyMs }
        : { ok: false, detail: `HTTP ${res.status} from ${this.baseUrl}/models`, latencyMs };
    } catch (err) {
      return { ok: false, detail: `unreachable at ${this.baseUrl}: ${(err as Error).message}` };
    }
  }

  async contextWindow(model: string) {
    // Local servers can say what they load; hosted APIs are configured from the catalog.
    if (this.tier === 'remote') return undefined;
    return probeContextWindow(this.baseUrl, model, { fetch: this.fetchImpl });
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const flavor = this.flavor;
    const origin: ModelRef = { provider: this.id, model: request.model };
    const effort = request.effort;
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      // OpenAI's reasoning models reject max_tokens.
      ...(flavor === 'openai'
        ? { max_completion_tokens: request.maxTokens }
        : { max_tokens: request.maxTokens }),
      ...(effort && flavor === 'deepseek'
        ? { reasoning_effort: DEEPSEEK_EFFORT[effort], thinking: { type: 'enabled' } }
        : effort
          ? { reasoning_effort: effort }
          : {}),
      messages: toWireMessages(
        request.system,
        request.messages,
        flavor === 'deepseek' ? origin : undefined,
      ),
      ...(request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw new ProviderError(`request to ${this.baseUrl} failed`, this.id, true, { cause: err });
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(
        `HTTP ${res.status} from ${this.id}: ${detail.slice(0, 500)}`,
        this.id,
        res.status >= 500 || res.status === 429,
      );
    }

    let text = '';
    let reasoningText = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finish: string | undefined;

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;
      let chunk: {
        choices?: {
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            reasoning?: string | null;
            tool_calls?: {
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: Parameters<typeof normalizeUsage>[0] | null;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) usage = normalizeUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        reasoningText += reasoning;
        yield { type: 'reasoning.delta', text: reasoning };
      }
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

    const parts: Part[] = [];
    // Kept in the transcript with its origin; only DeepSeek gets it back.
    if (reasoningText) parts.push({ type: 'reasoning', text: reasoningText, origin });
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
