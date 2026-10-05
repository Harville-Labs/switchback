/**
 * TypeSafe's System One API (Jev): a decision model that answers typed
 * questions about text with calibrated values, never prose. Switchback uses it
 * to rate prompts for the router's classifier; it can't hold a conversation.
 * Servers that speak the same API (OpenJev, LocalJev) work through `baseUrl`.
 */
import type { Tier } from '@switchback/protocol';
import { APIError, APIUserAbortError, TypeSafeClient } from '@typesafe-ai/sdk';
import {
  type ChatEvent,
  type HealthStatus,
  type Provider,
  ProviderError,
  type RateRequest,
  type RateResult,
} from './types.ts';

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';

export interface TypeSafeOptions {
  id: string;
  tier: Tier;
  baseUrl?: string;
  apiKey?: string;
  missingKeyHint?: string;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export class TypeSafeProvider implements Provider {
  readonly id: string;
  readonly tier: Tier;
  readonly decisionOnly = true;
  private client: TypeSafeClient | undefined;

  constructor(private readonly options: TypeSafeOptions) {
    this.id = options.id;
    this.tier = options.tier;
  }

  /** Built on first use: the SDK refuses to construct without a key. */
  private sdk(): TypeSafeClient {
    this.client ??= new TypeSafeClient({
      // Every option is explicit so the SDK never reads TYPESAFE_* variables itself.
      // Self-hosted servers usually take no key; the SDK still needs one to send.
      apiKey: this.options.apiKey || 'unused',
      baseURL: this.options.baseUrl ?? TYPESAFE_BASE_URL,
      defaultModel: 'jev-latest',
      // Its debug logging includes request bodies, which hold the user's prompt.
      logLevel: 'off',
      // The classifier has its own deadline; a retry would only overrun it.
      retry: { maxRetries: 0 },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    return this.client;
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    if (this.tier === 'remote' && !this.options.apiKey)
      return { ok: false, detail: `no API key (${this.options.missingKeyHint ?? 'set apiKey'})` };
    const base = this.options.baseUrl ?? TYPESAFE_BASE_URL;
    const started = performance.now();
    try {
      const models = await this.sdk().models.list({ timeout: 2000, ...(signal ? { signal } : {}) });
      return {
        ok: true,
        detail: `reachable at ${base}`,
        latencyMs: Math.round(performance.now() - started),
        models: models.map((m) => m.name),
      };
    } catch (err) {
      if (err instanceof APIError) return { ok: false, detail: `HTTP ${err.status} from ${base}` };
      return { ok: false, detail: `unreachable at ${base}: ${(err as Error).message}` };
    }
  }

  // biome-ignore lint/correctness/useYield: decision models have nothing to stream.
  async *stream(): AsyncIterable<ChatEvent> {
    throw new ProviderError(
      `${this.id} serves decision models (TypeSafe Jev), which can't hold a conversation; use it for routing.classifier.model`,
      this.id,
      false,
    );
  }

  async rate(request: RateRequest): Promise<RateResult> {
    try {
      const { answers, usage } = await this.sdk().systemOne(
        {
          model: request.model,
          state: request.text,
          questions: {
            rating: { type: 'score', instructions: request.instructions, criteria: request.levels },
          },
        },
        {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(request.timeoutMs ? { timeout: request.timeoutMs } : {}),
        },
      );
      const { score, confidence } = answers.rating;
      return {
        level: Math.min(request.levels.length - 1, Math.max(0, Math.round(score))),
        score,
        confidence,
        usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
      };
    } catch (err) {
      if (err instanceof APIUserAbortError) throw err;
      const status = err instanceof APIError ? err.status : undefined;
      // 429, 529 (overloaded), 5xx, and connection failures are worth trying again later.
      const retryable = status === undefined || status === 429 || status >= 500;
      throw new ProviderError(`${this.id}: ${(err as Error).message}`, this.id, retryable, {
        cause: err,
      });
    }
  }
}
