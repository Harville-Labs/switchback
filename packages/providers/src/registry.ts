import type { Tier } from '@harness/protocol';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';
import { ScriptedProvider } from './scripted.ts';
import type { Provider } from './types.ts';

/** `{env:NAME}` references are resolved at load time so secrets stay out of config files. */
const Secret = z.string();

export const ProviderConfig = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('openai-compatible'),
    baseUrl: z.url(),
    apiKey: Secret.optional(),
    tier: z.enum(['local', 'remote']).default('local'),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal('openai'),
    /** Defaults to $OPENAI_API_KEY. */
    apiKey: Secret.optional(),
    baseUrl: z.url().default('https://api.openai.com/v1'),
    organization: z.string().optional(),
  }),
  z.object({
    type: z.literal('deepseek'),
    /** Defaults to $DEEPSEEK_API_KEY. */
    apiKey: Secret.optional(),
    baseUrl: z.url().default('https://api.deepseek.com'),
  }),
  z.object({
    type: z.literal('anthropic'),
    apiKey: Secret.optional(),
    baseUrl: z.url().optional(),
  }),
  z.object({
    type: z.literal('bedrock'),
    region: z.string().optional(),
    profile: z.string().optional(),
    eagerToolInputStreaming: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('vertex'),
    projectId: z.string(),
    region: z.string().default('global'),
  }),
  z.object({
    type: z.literal('mock'),
    tier: z.enum(['local', 'remote']).default('local'),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export function tierOf(config: ProviderConfig): Tier {
  return config.type === 'openai-compatible' || config.type === 'mock' ? config.tier : 'remote';
}

/** Credential env var for each hosted provider type, for setup and diagnostics. */
export const CREDENTIAL_ENV: Partial<Record<ProviderConfig['type'], string>> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

const NO_THINKING = ['claude-haiku-4-5', 'anthropic.claude-haiku-4-5'];

export function createProvider(id: string, config: ProviderConfig): Provider {
  switch (config.type) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        id,
        baseUrl: config.baseUrl,
        tier: config.tier,
        ...(config.tier === 'remote' ? { missingKeyHint: 'set providers.<id>.apiKey' } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
      });
    case 'openai': {
      const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
      return new OpenAICompatibleProvider({
        id,
        baseUrl: config.baseUrl,
        tier: 'remote',
        flavor: 'openai',
        missingKeyHint: 'set OPENAI_API_KEY or providers.<id>.apiKey',
        ...(apiKey ? { apiKey } : {}),
        ...(config.organization ? { headers: { 'OpenAI-Organization': config.organization } } : {}),
      });
    }
    case 'deepseek': {
      const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
      return new OpenAICompatibleProvider({
        id,
        baseUrl: config.baseUrl,
        tier: 'remote',
        flavor: 'deepseek',
        missingKeyHint: 'set DEEPSEEK_API_KEY or providers.<id>.apiKey',
        ...(apiKey ? { apiKey } : {}),
      });
    }
    case 'anthropic':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: {
          kind: 'anthropic',
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        },
        noThinkingModels: NO_THINKING,
      });
    case 'bedrock':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: {
          kind: 'bedrock',
          ...(config.region ? { region: config.region } : {}),
          ...(config.profile ? { profile: config.profile } : {}),
        },
        eagerToolInputStreaming: config.eagerToolInputStreaming,
        noThinkingModels: NO_THINKING,
      });
    case 'vertex':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: { kind: 'vertex', projectId: config.projectId, region: config.region },
        noThinkingModels: NO_THINKING,
      });
    case 'mock':
      return new ScriptedProvider(id, config.tier, (req) => ({
        text: `[mock ${id}] You said: ${lastUserText(req.messages)}`,
      }));
  }
}

function lastUserText(messages: { role: string; parts: { type: string; text?: string }[] }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = m?.role === 'user' ? m.parts.find((p) => p.type === 'text')?.text : undefined;
    if (text) return text;
  }
  return '';
}
