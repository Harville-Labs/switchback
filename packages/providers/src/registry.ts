import type { Tier } from '@switchback/protocol';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.ts';
import { GeminiProvider } from './gemini.ts';
import { flavorForUrl, OpenAICompatibleProvider } from './openai-compatible.ts';
import { OpenAIResponsesProvider } from './openai-responses.ts';
import { ScriptedProvider, type ScriptedTurn } from './scripted.ts';
import type { ApiKeySource, ChatRequest, Provider } from './types.ts';

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
    /**
     * `responses` uses the Responses API, which keeps reasoning between tool
     * calls (recommended for reasoning models); `chat` uses Chat Completions.
     */
    api: z.enum(['chat', 'responses']).default('chat'),
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
    /**
     * `server`: when a safety classifier declines, the API retries on the model
     * Anthropic recommends for that category (`fallbacks: "default"`), in the
     * same request. `off`: refusals come back to Switchback, which tries the next
     * model up `routing.escalate` like it does for every provider.
     */
    refusalFallback: z.enum(['server', 'off']).default('server'),
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
    /** Claude Platform on AWS: Anthropic-operated, SigV4 auth, AWS billing. Bare model IDs. */
    type: z.literal('anthropic-aws'),
    region: z.string().optional(),
    workspaceId: z.string().optional(),
    profile: z.string().optional(),
    refusalFallback: z.enum(['server', 'off']).default('server'),
  }),
  z.object({
    type: z.literal('foundry'),
    /** Foundry resource name (`https://<resource>.services.ai.azure.com`). */
    resource: z.string().optional(),
    apiKey: Secret.optional(),
    baseUrl: z.url().optional(),
  }),
  z.object({
    /**
     * Azure OpenAI's v1 API, which takes the OpenAI client as is. Models are
     * deployment names.
     */
    type: z.literal('azure-openai'),
    /** Resource name (`https://<resource>.openai.azure.com/openai/v1`); or set `baseUrl`. */
    resource: z.string().optional(),
    baseUrl: z.url().optional(),
    /** Defaults to $AZURE_OPENAI_API_KEY. */
    apiKey: Secret.optional(),
    /**
     * `key`: an API key. `entra`: Microsoft Entra ID tokens from the Azure
     * credential chain (environment, workload or managed identity, `az login`).
     */
    auth: z.enum(['key', 'entra']).default('key'),
    /** Microsoft recommends the Responses API for Azure OpenAI models. */
    api: z.enum(['chat', 'responses']).default('responses'),
  }),
  z.object({
    /** Google Gemini: the Gemini API with a key, or Vertex AI with `project` and `location`. */
    type: z.literal('gemini'),
    /** Defaults to $GEMINI_API_KEY (or $GOOGLE_API_KEY). */
    apiKey: Secret.optional(),
    project: z.string().optional(),
    location: z.string().default('global'),
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
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const NO_THINKING = ['claude-haiku-4-5', 'anthropic.claude-haiku-4-5'];

/** The token audience Azure OpenAI's v1 API documents for Entra ID. */
export const AZURE_ENTRA_SCOPE = 'https://ai.azure.com/.default';

/**
 * A Microsoft Entra ID token function for the OpenAI SDK, which calls it before
 * each request; the library caches tokens and refreshes them before they
 * expire. `@azure/identity` is loaded on first use, so only Entra users pay for it.
 */
function entraToken(): () => Promise<string> {
  let provider: Promise<() => Promise<string>> | undefined;
  return async () => {
    provider ??= import('@azure/identity').then(
      ({ DefaultAzureCredential, getBearerTokenProvider }) =>
        getBearerTokenProvider(new DefaultAzureCredential(), AZURE_ENTRA_SCOPE),
    );
    try {
      return await (await provider)();
    } catch (err) {
      // The chain's own message runs to a paragraph per credential it tried.
      const first = String((err as Error).message ?? err).split('\n')[0];
      throw new Error(
        `Microsoft Entra ID sign-in failed (${first}). Sign in with \`az login\`, set AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_CLIENT_SECRET, or run with a managed identity.`,
        { cause: err },
      );
    }
  };
}

/** The v1 endpoint for an `azure-openai` provider; config validation requires one of the two. */
export function azureOpenAIBaseUrl(config: { resource?: string; baseUrl?: string }): string {
  if (config.baseUrl) return config.baseUrl;
  if (!config.resource) throw new Error('azure-openai needs `resource` or `baseUrl`');
  return `https://${config.resource}.openai.azure.com/openai/v1`;
}

/** OpenAI and APIs that take the OpenAI client unchanged (Azure OpenAI's v1 API). */
function openAIFamily(
  id: string,
  o: {
    baseUrl: string;
    api: 'chat' | 'responses';
    apiKey: ApiKeySource | undefined;
    missingKeyHint: string;
    headers?: Record<string, string>;
  },
): Provider {
  const common = {
    id,
    baseUrl: o.baseUrl,
    missingKeyHint: o.missingKeyHint,
    ...(o.apiKey ? { apiKey: o.apiKey } : {}),
    ...(o.headers ? { headers: o.headers } : {}),
  };
  return o.api === 'responses'
    ? new OpenAIResponsesProvider(common)
    : new OpenAICompatibleProvider({ ...common, tier: 'remote', flavor: 'openai' });
}

export function createProvider(id: string, config: ProviderConfig): Provider {
  switch (config.type) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        id,
        baseUrl: config.baseUrl,
        tier: config.tier,
        flavor: flavorForUrl(config.baseUrl),
        ...(config.tier === 'remote' ? { missingKeyHint: `set providers.${id}.apiKey` } : {}),
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.headers ? { headers: config.headers } : {}),
      });
    case 'openai':
      return openAIFamily(id, {
        baseUrl: config.baseUrl,
        api: config.api,
        apiKey: config.apiKey || process.env.OPENAI_API_KEY,
        missingKeyHint: `set OPENAI_API_KEY or providers.${id}.apiKey`,
        ...(config.organization ? { headers: { 'OpenAI-Organization': config.organization } } : {}),
      });
    case 'azure-openai':
      return openAIFamily(id, {
        baseUrl: azureOpenAIBaseUrl(config),
        api: config.api,
        apiKey:
          config.auth === 'entra'
            ? entraToken()
            : config.apiKey || process.env.AZURE_OPENAI_API_KEY,
        missingKeyHint: `set AZURE_OPENAI_API_KEY, providers.${id}.apiKey, or "auth": "entra"`,
      });
    case 'deepseek': {
      const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
      return new OpenAICompatibleProvider({
        id,
        baseUrl: config.baseUrl,
        tier: 'remote',
        flavor: 'deepseek',
        missingKeyHint: `set DEEPSEEK_API_KEY or providers.${id}.apiKey`,
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
        serverFallback: config.refusalFallback === 'server',
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
    case 'anthropic-aws':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: {
          kind: 'aws',
          ...(config.region ? { region: config.region } : {}),
          ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
          ...(config.profile ? { profile: config.profile } : {}),
        },
        noThinkingModels: NO_THINKING,
        serverFallback: config.refusalFallback === 'server',
      });
    case 'foundry':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: {
          kind: 'foundry',
          ...(config.resource ? { resource: config.resource } : {}),
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        },
        noThinkingModels: NO_THINKING,
      });
    case 'gemini': {
      const apiKey = config.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      return new GeminiProvider({
        id,
        ...(config.project
          ? { vertex: { project: config.project, location: config.location } }
          : apiKey
            ? { apiKey }
            : {}),
      });
    }
    case 'vertex':
      return new AnthropicProvider({
        id,
        tier: 'remote',
        platform: { kind: 'vertex', projectId: config.projectId, region: config.region },
        noThinkingModels: NO_THINKING,
      });
    case 'mock':
      return new ScriptedProvider(id, config.tier, (req) => mockTurn(id, req.messages));
  }
}

/**
 * The mock provider echoes prompts. For demos and client development it can
 * also call a tool: a prompt of `mock:tool {"name": "...", "input": {...}}`
 * makes one tool call, then reports the result.
 */
function mockTurn(id: string, messages: ChatRequest['messages']): ScriptedTurn {
  const last = messages.at(-1);
  const result = last?.parts.find((p) => p.type === 'tool_result');
  if (result?.type === 'tool_result') {
    return {
      text: `[mock ${id}] tool ${result.isError ? 'failed' : 'finished'}: ${result.content.split('\n')[0]}`,
    };
  }
  const text = lastUserText(messages);
  const call = /^mock:tool\s+(\{[\s\S]*\})\s*$/.exec(text);
  if (call?.[1]) {
    try {
      const { name, input } = JSON.parse(call[1]) as { name: string; input: unknown };
      return { toolCalls: [{ name, input }] };
    } catch {
      return { text: `[mock ${id}] could not parse mock:tool JSON` };
    }
  }
  return { text: `[mock ${id}] You said: ${text}` };
}

function lastUserText(messages: { role: string; parts: { type: string; text?: string }[] }[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = m?.role === 'user' ? m.parts.find((p) => p.type === 'text')?.text : undefined;
    if (text) return text;
  }
  return '';
}
