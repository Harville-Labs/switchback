/**
 * Adapter for OpenAI-compatible chat completion servers. This is the local
 * inference path: Ollama, llama.cpp `llama-server`, LM Studio, vLLM, and MLX
 * servers all expose `/v1/chat/completions` with SSE streaming.
 */
import type { Part, StopReason, Tier, Usage } from '@harness/protocol';
import {
  type ChatEvent,
  type ChatRequest,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  tier: Tier;
  headers?: Record<string, string>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toWireMessages(system: string, messages: ChatRequest['messages']): WireMessage[] {
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
      // Reasoning from any model is never replayed to an OpenAI-style server.
      const text = m.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
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

  async health(signal?: AbortSignal): Promise<HealthStatus> {
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

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const body = {
      model: request.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens,
      messages: toWireMessages(request.system, request.messages),
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
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { type: 'reasoning.delta', text: reasoning };
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
