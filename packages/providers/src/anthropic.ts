/**
 * Claude via the Messages API. One adapter serves every platform that exposes
 * the Messages surface; only client construction differs:
 *
 * - `anthropic`: first-party Claude API (`@anthropic-ai/sdk`)
 * - `bedrock`:   Amazon Bedrock via the Mantle client (`@anthropic-ai/bedrock-sdk`)
 * - `vertex`:    Google Cloud Vertex AI (`@anthropic-ai/vertex-sdk`)
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { Message, Part, StopReason, Tier } from '@harness/protocol';
import {
  type ChatEvent,
  type ChatRequest,
  type HealthStatus,
  type Provider,
  ProviderError,
} from './types.ts';

export type AnthropicPlatform =
  | { kind: 'anthropic'; apiKey?: string; baseUrl?: string }
  | { kind: 'bedrock'; region?: string; profile?: string }
  | { kind: 'vertex'; projectId: string; region: string };

export interface AnthropicProviderOptions {
  id: string;
  tier: Tier;
  platform: AnthropicPlatform;
  /**
   * Stream tool inputs as they are generated. Off by default on Bedrock, where
   * older model deployments reject the field.
   */
  eagerToolInputStreaming?: boolean;
  /** Models that do not accept adaptive thinking (e.g. Haiku 4.5). */
  noThinkingModels?: string[];
  /**
   * First-party API only: ask the API to retry classifier refusals on its
   * recommended fallback model (`fallbacks: "default"`, beta
   * `server-side-fallback-2026-07-01`). Bedrock and Vertex don't offer it.
   */
  serverFallback?: boolean;
  /** Injected for tests. */
  client?: MessagesClient;
}

/** The slice of the SDK client this adapter uses; every platform client satisfies it. */
export interface MessagesClient {
  messages: Pick<Anthropic['messages'], 'stream'>;
  beta?: { messages: Pick<Anthropic['beta']['messages'], 'stream'> };
}

const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function createClient(platform: AnthropicPlatform): MessagesClient {
  switch (platform.kind) {
    case 'anthropic':
      return new Anthropic({
        ...(platform.apiKey ? { apiKey: platform.apiKey } : {}),
        ...(platform.baseUrl ? { baseURL: platform.baseUrl } : {}),
      });
    case 'bedrock':
      return new AnthropicBedrockMantle({
        ...(platform.region ? { awsRegion: platform.region } : {}),
        ...(platform.profile ? { awsProfile: platform.profile } : {}),
      }) as unknown as MessagesClient;
    case 'vertex':
      return new AnthropicVertex({
        projectId: platform.projectId,
        region: platform.region,
      }) as unknown as MessagesClient;
  }
}

/**
 * Translate the neutral transcript into Messages API params. Reasoning is only
 * replayed when it came from this exact provider and model; blocks from other
 * models are dropped (the API would ignore them anyway, and the transcript
 * itself stays untouched so history remains append-only).
 */
export function toAnthropicMessages(
  providerId: string,
  model: string,
  messages: Message[],
): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const p of m.parts) {
      switch (p.type) {
        case 'text':
          if (p.text) content.push({ type: 'text', text: p.text });
          break;
        case 'reasoning': {
          const sameModel = p.origin.provider === providerId && p.origin.model === model;
          const signature = (p.opaque as { signature?: string } | undefined)?.signature;
          if (sameModel && signature) {
            content.push({ type: 'thinking', thinking: p.text, signature });
          }
          break;
        }
        case 'tool_call':
          content.push({
            type: 'tool_use',
            id: toolUseId(p.id),
            name: p.name,
            input: (p.input ?? {}) as Record<string, unknown>,
          });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: toolUseId(p.callId),
            content: p.content,
            ...(p.isError ? { is_error: true } : {}),
          });
          break;
      }
    }
    return { role: m.role, content };
  });
}

/**
 * Tool-call ids minted by local servers may contain characters the Messages
 * API rejects. Map them deterministically so tool_use and tool_result agree.
 */
export function toolUseId(id: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const STOP_MAP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  refusal: 'refusal',
  pause_turn: 'end_turn',
};

export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly tier: Tier;
  private client: MessagesClient | undefined;
  /** Models whose requests rejected the `fallbacks` parameter; never sent again. */
  private noServerFallback = new Set<string>();

  constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id;
    this.tier = options.tier;
    this.client = options.client;
  }

  private getClient(): MessagesClient {
    this.client ??= createClient(this.options.platform);
    return this.client;
  }

  async health(): Promise<HealthStatus> {
    // Remote health is inferred from credentials; a live probe would cost money.
    const platform = this.options.platform;
    if (platform.kind === 'anthropic' && !platform.apiKey && !hasAnthropicCredentials()) {
      return {
        ok: false,
        detail: 'no credentials found (set ANTHROPIC_API_KEY or run `ant auth login`)',
      };
    }
    try {
      this.getClient();
      return { ok: true, detail: `${platform.kind} client configured` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    const eager = this.options.eagerToolInputStreaming ?? this.options.platform.kind !== 'bedrock';
    const thinking = !(this.options.noThinkingModels ?? []).includes(request.model);

    const params: Anthropic.MessageStreamParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      // Frozen system prompt + deterministic tool order keep the cached prefix stable.
      system: request.system,
      cache_control: { type: 'ephemeral' },
      messages: toAnthropicMessages(this.id, request.model, request.messages),
      ...(request.tools.length
        ? {
            tools: request.tools.map(
              (t): Anthropic.Tool => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                ...(eager ? { eager_input_streaming: true } : {}),
              }),
            ),
          }
        : {}),
      ...(thinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    };

    const useFallback =
      this.options.serverFallback === true &&
      this.options.platform.kind === 'anthropic' &&
      !this.noServerFallback.has(request.model);

    let final: Anthropic.Message | Anthropic.Beta.BetaMessage;
    let streamed = false;
    try {
      const client = this.getClient();
      const stream =
        useFallback && client.beta
          ? client.beta.messages.stream(
              {
                ...(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming),
                betas: [SERVER_FALLBACK_BETA],
                fallbacks: 'default',
              },
              { signal: request.signal },
            )
          : client.messages.stream(params, { signal: request.signal });
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          streamed = true;
          yield { type: 'text.delta', text: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          streamed = true;
          yield { type: 'reasoning.delta', text: event.delta.thinking };
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      if (request.signal?.aborted) throw err;
      // A model that doesn't take the parameter answers 400 before any output:
      // remember that and send the request again without it.
      if (
        useFallback &&
        !streamed &&
        err instanceof Anthropic.BadRequestError &&
        /fallback/i.test(err.message)
      ) {
        this.noServerFallback.add(request.model);
        yield* this.stream(request);
        return;
      }
      throw toProviderError(this.id, err);
    }

    // After a server-side fallback, only blocks after the last `fallback`
    // marker came from the model that finished; text before it is kept, but
    // the declining model's thinking and tool calls must not be echoed back.
    const content = final.content as { type: string }[];
    const boundary = content.map((b) => b.type).lastIndexOf('fallback');
    // The served-by signal is a `fallback_message` iteration; sticky-served turns
    // (the fallback keeps answering for a while) have no marker block.
    const iterations = (final.usage as { iterations?: { type: string }[] | null }).iterations;
    const fellBack = boundary >= 0 || !!iterations?.some((it) => it.type === 'fallback_message');
    const servedBy = fellBack && final.stop_reason !== 'refusal' ? final.model : undefined;
    const origin = { provider: this.id, model: servedBy ?? request.model };
    const parts: Part[] = [];
    content.forEach((raw, i) => {
      const beforeSwitch = i < boundary;
      const block = raw as Anthropic.ContentBlock;
      if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (beforeSwitch) return;
      else if (block.type === 'thinking')
        parts.push({
          type: 'reasoning',
          text: block.thinking,
          origin,
          opaque: { signature: block.signature },
        });
      else if (block.type === 'tool_use')
        parts.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
    });

    yield {
      type: 'done',
      parts,
      stopReason: STOP_MAP[final.stop_reason ?? 'end_turn'] ?? 'end_turn',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
      ...(servedBy ? { model: servedBy } : {}),
    };
  }
}

/** Mirrors the SDK's credential chain closely enough to warn before the first request. */
export function hasAnthropicCredentials(): boolean {
  const env = process.env;
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID) return true;
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return existsSync(join(configHome, 'anthropic'));
}

function toProviderError(providerId: string, err: unknown): ProviderError {
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`connection to ${providerId} failed`, providerId, true, {
      cause: err,
    });
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return new ProviderError(err.message, providerId, true, { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new ProviderError(err.message, providerId, false, { cause: err });
  }
  return new ProviderError((err as Error)?.message ?? String(err), providerId, false, {
    cause: err,
  });
}
