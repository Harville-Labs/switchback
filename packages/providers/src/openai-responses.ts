/**
 * OpenAI's Responses API, via the official SDK. Compared with Chat
 * Completions it keeps reasoning between tool calls: with `store: false` the
 * API returns reasoning as encrypted items, which the transcript keeps (with
 * their origin) and replays only to the same model, the same rule as Claude
 * thinking blocks and DeepSeek `reasoning_content`.
 */
import type { Message, ModelRef, Part, StopReason, Usage } from '@switchback/protocol';
import OpenAI from 'openai';
import type {
  Response,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import {
  type ApiKeySource,
  type ChatEvent,
  type ChatRequest,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export interface OpenAIResponsesOptions {
  id: string;
  baseUrl: string;
  apiKey?: ApiKeySource;
  missingKeyHint?: string;
  headers?: Record<string, string>;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

/** Opaque payload kept on reasoning parts so they can be sent back verbatim. */
interface ReasoningOpaque {
  responsesItem: { id: string; encrypted_content?: string | null; summary: { text: string }[] };
}

/** Translate the neutral transcript into Responses input items, in order. */
export function toResponsesInput(messages: Message[], origin: ModelRef): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text: string[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result')
          items.push({
            type: 'function_call_output',
            call_id: p.callId,
            output: p.isError ? `Error: ${p.content}` : p.content,
          });
        else if (p.type === 'text') text.push(p.text);
      }
      if (text.length) items.push({ role: 'user', content: text.join('\n') });
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) items.push({ role: 'assistant', content: p.text });
      else if (p.type === 'tool_call')
        items.push({
          type: 'function_call',
          call_id: p.id,
          name: p.name,
          arguments: JSON.stringify(p.input ?? {}),
        });
      else if (
        p.type === 'reasoning' &&
        p.origin.provider === origin.provider &&
        p.origin.model === origin.model
      ) {
        const item = (p.opaque as ReasoningOpaque | undefined)?.responsesItem;
        if (item?.encrypted_content)
          items.push({
            type: 'reasoning',
            id: item.id,
            encrypted_content: item.encrypted_content,
            summary: item.summary.map((s) => ({ type: 'summary_text' as const, text: s.text })),
          });
      }
    }
  }
  return items;
}

/** Canonical parts, stop reason, and usage from a finished response. */
export function fromResponse(
  response: Response,
  origin: ModelRef,
): { parts: Part[]; stopReason: StopReason; usage: Usage } {
  const parts: Part[] = [];
  let refused = false;
  let calls = 0;
  for (const item of response.output) {
    if (item.type === 'reasoning') {
      const summary = item.summary.map((s) => ({ text: s.text }));
      parts.push({
        type: 'reasoning',
        text: summary.map((s) => s.text).join('\n\n'),
        origin,
        opaque: {
          responsesItem: {
            id: item.id,
            encrypted_content: item.encrypted_content ?? null,
            summary,
          },
        } satisfies ReasoningOpaque,
      });
    } else if (item.type === 'message') {
      for (const c of item.content) {
        if (c.type === 'output_text') parts.push({ type: 'text', text: c.text });
        else if (c.type === 'refusal') {
          refused = true;
          parts.push({ type: 'text', text: c.refusal });
        }
      }
    } else if (item.type === 'function_call') {
      calls++;
      let input: unknown;
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        input = { __malformed: item.arguments };
      }
      parts.push({ type: 'tool_call', id: item.call_id, name: item.name, input });
    }
  }
  const reason = response.incomplete_details?.reason;
  const stopReason: StopReason =
    reason === 'max_output_tokens'
      ? 'max_tokens'
      : reason === 'content_filter' || refused
        ? 'refusal'
        : calls
          ? 'tool_use'
          : 'end_turn';
  const u = response.usage;
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return {
    parts,
    stopReason,
    usage: {
      inputTokens: Math.max(0, (u?.input_tokens ?? 0) - cached),
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}

export class OpenAIResponsesProvider implements Provider {
  readonly id: string;
  readonly tier = 'remote' as const;
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIResponsesOptions) {
    this.id = options.id;
    this.client = new OpenAI({
      baseURL: options.baseUrl.replace(/\/+$/, ''),
      // Explicit, so OPENAI_* in the environment never override the config.
      apiKey: options.apiKey ?? 'unused',
      adminAPIKey: null,
      organization: null,
      project: null,
      webhookSecret: null,
      ...(options.headers ? { defaultHeaders: options.headers } : {}),
      maxRetries: 2,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    if (!this.options.apiKey)
      return { ok: false, detail: `no API key (${this.options.missingKeyHint ?? 'set apiKey'})` };
    const started = performance.now();
    try {
      await this.client.models.list({
        maxRetries: 0,
        timeout: 3000,
        ...(signal ? { signal } : {}),
      });
      return { ok: true, detail: 'reachable', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const origin: ModelRef = { provider: this.id, model: request.model };
    let final: Response | undefined;
    try {
      const stream = await this.client.responses.create(
        {
          model: request.model,
          instructions: request.system,
          input: toResponsesInput(request.messages, origin),
          max_output_tokens: request.maxTokens,
          // Nothing is stored server-side; reasoning comes back encrypted instead.
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(request.effort
            ? {
                reasoning: {
                  effort: request.effort === 'max' ? 'xhigh' : request.effort,
                  ...(request.effort === 'none' ? {} : { summary: 'auto' as const }),
                },
              }
            : {}),
          ...(request.tools.length
            ? {
                tools: request.tools.map((t) => ({
                  type: 'function' as const,
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema,
                  strict: false,
                })),
              }
            : {}),
          stream: true,
        },
        { ...(request.signal ? { signal: request.signal } : {}) },
      );
      for await (const ev of stream as AsyncIterable<ResponseStreamEvent>) {
        if (ev.type === 'response.output_text.delta') yield { type: 'text.delta', text: ev.delta };
        else if (ev.type === 'response.reasoning_summary_text.delta')
          yield { type: 'reasoning.delta', text: ev.delta };
        else if (ev.type === 'response.completed' || ev.type === 'response.incomplete')
          final = ev.response;
        else if (ev.type === 'response.failed')
          throw new ProviderError(
            `${this.id}: ${ev.response.error?.message ?? 'response failed'}`,
            this.id,
            ev.response.error?.code === 'server_error' ||
              ev.response.error?.code === 'rate_limit_exceeded',
          );
      }
    } catch (err) {
      if (request.signal?.aborted || err instanceof ProviderError) throw err;
      if (err instanceof OpenAI.APIConnectionError)
        throw new ProviderError(`${this.id} is unreachable: ${err.message}`, this.id, true, {
          cause: err,
        });
      if (err instanceof OpenAI.APIError) {
        const status = err.status ?? 0;
        throw new ProviderError(
          `HTTP ${status} from ${this.id}: ${err.message.slice(0, 500)}`,
          this.id,
          status === 408 || status === 429 || status >= 500,
          { cause: err },
        );
      }
      throw new ProviderError(`${this.id} failed: ${(err as Error).message}`, this.id, false, {
        cause: err,
      });
    }
    if (!final)
      throw new ProviderError(`${this.id} ended the stream without a response`, this.id, true);
    yield { type: 'done', ...fromResponse(final, origin) };
  }
}
