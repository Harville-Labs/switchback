/**
 * OpenCode's model gateways: Go (a monthly subscription to open coding
 * models) and Zen (pay as you go). One key covers every model, but each
 * model speaks one of three APIs, so this provider hands each request to the
 * adapter for that model's API: Chat Completions, Anthropic Messages, or the
 * OpenAI Responses API.
 */
import type { Tier } from '@switchback/protocol';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { OpenAIResponsesProvider } from './openai-responses.ts';
import {
  type ChatEvent,
  type ChatRequest,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export type OpenCodePlan = 'go' | 'zen';
export type OpenCodeApi = 'chat' | 'messages' | 'responses';

export const OPENCODE_BASE_URL: Record<OpenCodePlan, string> = {
  go: 'https://opencode.ai/zen/go',
  zen: 'https://opencode.ai/zen',
};

export const OPENCODE_KEY_ENV = 'OPENCODE_API_KEY';

/**
 * Which API OpenCode serves a model on, by model family, from its docs
 * (opencode.ai/docs/go and /docs/zen, checked 2026-10-09). Undefined for
 * Gemini, which it serves on Google's API. `overrides` (the provider's `api`
 * setting) covers models added since.
 */
export function openCodeApi(
  model: string,
  overrides: Record<string, OpenCodeApi> = {},
): OpenCodeApi | undefined {
  const fixed = overrides[model];
  if (fixed) return fixed;
  if (/^(claude|qwen)/.test(model)) return 'messages';
  if (/^(gpt|grok)/.test(model)) return 'responses';
  if (/^gemini/.test(model)) return undefined;
  return 'chat';
}

export interface OpenCodeOptions {
  id: string;
  plan: OpenCodePlan;
  apiKey?: string;
  api?: Record<string, OpenCodeApi>;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** The adapters, injected for tests. */
  adapters?: Partial<Record<OpenCodeApi, Provider>>;
}

export class OpenCodeProvider implements Provider {
  readonly id: string;
  readonly tier: Tier = 'remote';
  private readonly adapters: Partial<Record<OpenCodeApi, Provider>>;
  private readonly hint: string;

  constructor(private readonly options: OpenCodeOptions) {
    this.id = options.id;
    this.hint = `set ${OPENCODE_KEY_ENV} or providers.${options.id}.apiKey`;
    this.adapters = options.adapters ?? {};
  }

  /** The adapter for an API, made on first use, once there's a key. */
  private adapter(api: OpenCodeApi, apiKey: string): Provider {
    const made = this.adapters[api];
    if (made) return made;
    const { id, plan } = this.options;
    const base = OPENCODE_BASE_URL[plan];
    const common = {
      id,
      baseUrl: `${base}/v1`,
      missingKeyHint: this.hint,
      apiKey,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    };
    const adapter =
      api === 'chat'
        ? new OpenAICompatibleProvider({ ...common, tier: 'remote', flavor: 'generic' })
        : api === 'responses'
          ? new OpenAIResponsesProvider(common)
          : new AnthropicProvider({
              id,
              tier: 'remote',
              // The SDK adds /v1/messages. Always OpenCode's key: the user's
              // own Anthropic key must never be sent here.
              platform: { kind: 'anthropic', apiKey, baseUrl: base },
            });
    this.adapters[api] = adapter;
    return adapter;
  }

  health(signal?: AbortSignal): Promise<HealthStatus> {
    const { apiKey } = this.options;
    if (!apiKey) return Promise.resolve({ ok: false, detail: `no API key (${this.hint})` });
    return this.adapter('chat', apiKey).health(signal);
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const { apiKey } = this.options;
    if (!apiKey) throw new ProviderError(`no OpenCode API key: ${this.hint}`, this.id, false);
    const api = openCodeApi(request.model, this.options.api);
    if (!api)
      throw new ProviderError(
        `OpenCode serves ${request.model} on Google's API, which Switchback doesn't use through OpenCode. Pick another model, or add a gemini provider.`,
        this.id,
        false,
      );
    yield* this.adapter(api, apiKey).stream(request);
  }
}
