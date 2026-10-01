/**
 * Google Gemini via the official `@google/genai` SDK, on the Gemini API (API
 * key) or Vertex AI (project + location).
 *
 * Gemini attaches thought signatures to the parts of a model turn and expects
 * them back verbatim. The adapter keeps the turn's raw parts on a reasoning
 * part (with its origin) and replays them exactly, only to the same model;
 * every other model gets the neutral translation.
 */
import {
  type Content,
  type Part as GeminiPart,
  type GenerateContentResponse,
  GoogleGenAI,
  ThinkingLevel,
} from '@google/genai';
import type { Message, ModelRef, Part, StopReason, Usage } from '@switchback/protocol';
import {
  type ChatEvent,
  type ChatRequest,
  type Effort,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export interface GeminiOptions {
  id: string;
  apiKey?: string;
  /** Vertex AI mode when set. */
  vertex?: { project: string; location: string };
  /** Injected for tests. */
  fetch?: typeof fetch;
}

interface GeminiOpaque {
  geminiParts: GeminiPart[];
}

/** Translate the neutral transcript into Gemini contents. */
export function toGeminiContents(messages: Message[], origin: ModelRef): Content[] {
  const names = new Map<string, string>();
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: GeminiPart[] = [];
      for (const p of m.parts) {
        if (p.type === 'text') parts.push({ text: p.text });
        else if (p.type === 'tool_result')
          parts.push({
            functionResponse: {
              id: p.callId,
              name: names.get(p.callId) ?? 'unknown',
              response: p.isError ? { error: p.content } : { output: p.content },
            },
          });
      }
      if (parts.length) contents.push({ role: 'user', parts });
      continue;
    }
    for (const p of m.parts) if (p.type === 'tool_call') names.set(p.id, p.name);
    // The same model gets its own turn back exactly as it sent it, signatures included.
    const own = m.parts.find(
      (p) =>
        p.type === 'reasoning' &&
        p.origin.provider === origin.provider &&
        p.origin.model === origin.model &&
        (p.opaque as GeminiOpaque | undefined)?.geminiParts,
    );
    if (own?.type === 'reasoning') {
      contents.push({ role: 'model', parts: (own.opaque as GeminiOpaque).geminiParts });
      continue;
    }
    const parts: GeminiPart[] = [];
    for (const p of m.parts) {
      if (p.type === 'text' && p.text) parts.push({ text: p.text });
      else if (p.type === 'tool_call')
        parts.push({
          functionCall: {
            id: p.id,
            name: p.name,
            args: (p.input ?? {}) as Record<string, unknown>,
          },
        });
    }
    if (parts.length) contents.push({ role: 'model', parts });
  }
  return contents;
}

/**
 * Gemini 3 models take a thinking level; 2.x models take a token budget,
 * where 0 turns thinking off.
 */
export function thinkingConfig(model: string, effort: Effort | undefined) {
  const base = { includeThoughts: true };
  if (!effort) return base;
  if (/^gemini-[3-9]/.test(model)) {
    const level =
      effort === 'none' || effort === 'low'
        ? ThinkingLevel.LOW
        : effort === 'medium'
          ? ThinkingLevel.MEDIUM
          : ThinkingLevel.HIGH;
    return { ...base, thinkingLevel: level };
  }
  const budget = { none: 0, low: 1_024, medium: 8_192, high: 24_576, xhigh: 24_576, max: 24_576 }[
    effort
  ];
  return budget === 0 ? { thinkingBudget: 0 } : { ...base, thinkingBudget: budget };
}

const REFUSALS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

export class GeminiProvider implements Provider {
  readonly id: string;
  readonly tier = 'remote' as const;
  private client: GoogleGenAI | undefined;

  constructor(private readonly options: GeminiOptions) {
    this.id = options.id;
  }

  private getClient(): GoogleGenAI {
    const httpOptions = this.options.fetch ? { fetch: this.options.fetch } : undefined;
    this.client ??= this.options.vertex
      ? new GoogleGenAI({
          vertexai: true,
          project: this.options.vertex.project,
          location: this.options.vertex.location,
          ...(httpOptions ? { httpOptions } : {}),
        })
      : new GoogleGenAI({
          ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
          ...(httpOptions ? { httpOptions } : {}),
        });
    return this.client;
  }

  async health(): Promise<HealthStatus> {
    // Like the Claude providers: inferred from credentials, since a probe would cost money.
    if (!this.options.vertex && !this.options.apiKey)
      return { ok: false, detail: 'no API key (set GEMINI_API_KEY or providers.<id>.apiKey)' };
    return {
      ok: true,
      detail: this.options.vertex ? `Vertex AI ${this.options.vertex.location}` : 'API key set',
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const origin: ModelRef = { provider: this.id, model: request.model };
    const raw: GeminiPart[] = [];
    let last: GenerateContentResponse | undefined;
    try {
      const stream = await this.getClient().models.generateContentStream({
        model: request.model,
        contents: toGeminiContents(request.messages, origin),
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxTokens,
          thinkingConfig: thinkingConfig(request.model, request.effort),
          ...(request.tools.length
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((t) => ({
                      name: t.name,
                      description: t.description,
                      parametersJsonSchema: t.inputSchema,
                    })),
                  },
                ],
              }
            : {}),
          ...(request.signal ? { abortSignal: request.signal } : {}),
        },
      });
      for await (const chunk of stream) {
        last = chunk;
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          raw.push(part);
          if (part.text && part.thought) yield { type: 'reasoning.delta', text: part.text };
          else if (part.text) yield { type: 'text.delta', text: part.text };
        }
      }
    } catch (err) {
      if (request.signal?.aborted) throw err;
      const status = (err as { status?: number }).status;
      const retryable = status === undefined || status === 408 || status === 429 || status >= 500;
      throw new ProviderError(
        `${this.id}${status ? ` HTTP ${status}` : ''}: ${(err as Error).message.slice(0, 500)}`,
        this.id,
        retryable,
        { cause: err },
      );
    }

    const parts: Part[] = [];
    const thoughts = raw.filter((p) => p.thought && p.text).map((p) => p.text);
    // Kept even without visible thoughts: the raw parts carry the signatures.
    parts.push({
      type: 'reasoning',
      text: thoughts.join(''),
      origin,
      opaque: { geminiParts: raw } satisfies GeminiOpaque,
    });
    const text = raw
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('');
    if (text) parts.push({ type: 'text', text });
    let calls = 0;
    for (const p of raw) {
      if (!p.functionCall?.name) continue;
      parts.push({
        type: 'tool_call',
        id: p.functionCall.id ?? `call_${calls}_${crypto.randomUUID().slice(0, 8)}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
      calls++;
    }

    const finish = last?.candidates?.[0]?.finishReason as string | undefined;
    const stopReason: StopReason =
      finish === 'MAX_TOKENS'
        ? 'max_tokens'
        : finish && REFUSALS.has(finish)
          ? 'refusal'
          : calls
            ? 'tool_use'
            : 'end_turn';
    const u = last?.usageMetadata;
    const cached = u?.cachedContentTokenCount ?? 0;
    const usage: Usage = {
      inputTokens: Math.max(0, (u?.promptTokenCount ?? 0) - cached),
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    yield { type: 'done', parts, usage, stopReason };
  }
}
