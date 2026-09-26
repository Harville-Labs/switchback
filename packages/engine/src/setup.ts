/**
 * Config setup: detect local model servers and turn setup answers into a
 * config layer. Used by `harness init`; kept here (not in the CLI) so any
 * client can drive setup through the same logic.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  deepMerge,
  defaultConfig,
  HarnessConfig,
  referenceProblem,
  stripJsonComments,
} from './config.ts';

export type LocalServerKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'openai-compatible';

export interface DetectedModel {
  id: string;
  /** Context the server will actually use, when it reports one. */
  contextWindow?: number;
  /** The model's maximum context, which may exceed what the server loads. */
  maxContext?: number;
  /** Whether the server reports tool-calling support; undefined when unknown. */
  tools?: boolean;
}

export interface DetectedServer {
  kind: LocalServerKind;
  label: string;
  /** OpenAI-compatible base URL (ends in /v1). */
  baseUrl: string;
  models: DetectedModel[];
  /** Setup guidance specific to this server. */
  note?: string;
}

export const KNOWN_SERVERS: { kind: LocalServerKind; label: string; origin: string }[] = [
  { kind: 'ollama', label: 'Ollama', origin: 'http://localhost:11434' },
  { kind: 'lmstudio', label: 'LM Studio', origin: 'http://localhost:1234' },
  { kind: 'llamacpp', label: 'llama.cpp server', origin: 'http://localhost:8080' },
  { kind: 'vllm', label: 'vLLM', origin: 'http://localhost:8000' },
];

/** Ollama loads models with this context unless num_ctx or OLLAMA_CONTEXT_LENGTH say otherwise. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function detectOllama(
  fetchImpl: Fetch,
  origin: string,
  env: Record<string, string | undefined>,
): Promise<DetectedServer> {
  const tags = (await getJson(fetchImpl, `${origin}/api/tags`)) as { models?: { name: string }[] };
  const envCtx = Number(env.OLLAMA_CONTEXT_LENGTH) || undefined;
  const models = await Promise.all(
    (tags.models ?? []).slice(0, 30).map(async ({ name }): Promise<DetectedModel> => {
      try {
        const show = (await getJson(fetchImpl, `${origin}/api/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
        })) as {
          capabilities?: string[];
          model_info?: Record<string, unknown>;
          parameters?: string;
        };
        const numCtx =
          Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(show.parameters ?? '')?.[1]) || undefined;
        const maxEntry = Object.entries(show.model_info ?? {}).find(([k]) =>
          k.endsWith('.context_length'),
        );
        const maxContext = typeof maxEntry?.[1] === 'number' ? maxEntry[1] : undefined;
        const loaded = numCtx ?? envCtx ?? OLLAMA_DEFAULT_CONTEXT;
        return {
          id: name,
          contextWindow: maxContext ? Math.min(loaded, maxContext) : loaded,
          ...(maxContext ? { maxContext } : {}),
          ...(show.capabilities ? { tools: show.capabilities.includes('tools') } : {}),
        };
      } catch {
        return { id: name };
      }
    }),
  );
  return {
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: `${origin}/v1`,
    models,
    ...(envCtx
      ? {}
      : {
          note: `Ollama loads models with a ${OLLAMA_DEFAULT_CONTEXT}-token context unless you raise it. For agent work set OLLAMA_CONTEXT_LENGTH=32768 (or num_ctx in a Modelfile), restart Ollama, and use that value here.`,
        }),
  };
}

async function detectOpenAICompatible(
  fetchImpl: Fetch,
  kind: LocalServerKind,
  label: string,
  origin: string,
): Promise<DetectedServer> {
  const list = (await getJson(fetchImpl, `${origin}/v1/models`)) as {
    data?: { id: string; max_model_len?: number }[];
  };
  const models: DetectedModel[] = (list.data ?? []).map((m) => ({
    id: m.id,
    ...(m.max_model_len ? { contextWindow: m.max_model_len } : {}),
  }));
  if (kind === 'lmstudio') {
    // LM Studio's REST API reports loaded and maximum context per model.
    try {
      const rich = (await getJson(fetchImpl, `${origin}/api/v0/models`)) as {
        data?: {
          id: string;
          type?: string;
          max_context_length?: number;
          loaded_context_length?: number;
        }[];
      };
      for (const r of rich.data ?? []) {
        const m = models.find((x) => x.id === r.id);
        if (!m) continue;
        if (r.type && r.type !== 'llm' && r.type !== 'vlm') m.tools = false;
        m.contextWindow = r.loaded_context_length ?? r.max_context_length;
        if (r.max_context_length) m.maxContext = r.max_context_length;
      }
    } catch {
      // Older LM Studio: fall back to the OpenAI listing.
    }
  }
  if (kind === 'llamacpp') {
    try {
      const props = (await getJson(fetchImpl, `${origin}/props`)) as {
        n_ctx?: number;
        default_generation_settings?: { n_ctx?: number };
      };
      const nCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
      if (nCtx) for (const m of models) m.contextWindow = nCtx;
    } catch {
      // Not every build exposes /props.
    }
  }
  return { kind, label, baseUrl: `${origin}/v1`, models };
}

/** Probe well-known local ports (and any extra URLs) in parallel. Unreachable servers are omitted. */
export async function detectLocalServers(
  options: { fetch?: Fetch; env?: Record<string, string | undefined>; extra?: string[] } = {},
): Promise<DetectedServer[]> {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const probes = [
    ...KNOWN_SERVERS.map((s) =>
      s.kind === 'ollama'
        ? detectOllama(fetchImpl, s.origin, env)
        : detectOpenAICompatible(fetchImpl, s.kind, s.label, s.origin),
    ),
    ...(options.extra ?? []).map((url) =>
      detectOpenAICompatible(
        fetchImpl,
        'openai-compatible',
        url,
        url.replace(/\/v1\/?$/, '').replace(/\/+$/, ''),
      ),
    ),
  ];
  const results = await Promise.allSettled(probes);
  return results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}

// ---------------------------------------------------------------------------
// Answers -> config
// ---------------------------------------------------------------------------

export const REMOTE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

export interface SetupAnswers {
  local?: {
    providerId: string;
    baseUrl: string;
    model: string;
    contextWindow: number;
    apiKeyEnv?: string;
  };
  remote:
    | { kind: 'none' }
    | { kind: 'anthropic'; model: string }
    | { kind: 'bedrock'; model: string; region: string; profile?: string }
    | { kind: 'vertex'; model: string; projectId: string; region: string };
  escalationPolicy: 'auto' | 'ask' | 'off';
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

const CONTEXT: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

/** Build the config layer described by the answers. */
export function buildSetupConfig(a: SetupAnswers): Record<string, unknown> {
  if (!a.local && a.remote.kind === 'none') {
    throw new Error('configure at least a local model or a remote provider');
  }
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};
  const routing: Record<string, unknown> = { escalation: { policy: a.escalationPolicy } };

  if (a.local) {
    providers[a.local.providerId] = {
      type: 'openai-compatible',
      baseUrl: a.local.baseUrl,
      tier: 'local',
      ...(a.local.apiKeyEnv ? { apiKey: `{env:${a.local.apiKeyEnv}}` } : {}),
    };
    models.local = {
      provider: a.local.providerId,
      model: a.local.model,
      contextWindow: a.local.contextWindow,
    };
  }

  const r = a.remote;
  if (r.kind !== 'none') {
    const id = r.kind;
    providers[id] =
      r.kind === 'anthropic'
        ? { type: 'anthropic' }
        : r.kind === 'bedrock'
          ? { type: 'bedrock', region: r.region, ...(r.profile ? { profile: r.profile } : {}) }
          : { type: 'vertex', projectId: r.projectId, region: r.region };
    // Bedrock model IDs carry the `anthropic.` prefix; the API and Vertex use bare IDs.
    const wire = (m: string) => (r.kind === 'bedrock' ? `anthropic.${m}` : m);
    const entry = (m: string) => ({
      provider: id,
      model: wire(m),
      contextWindow: CONTEXT[m] ?? 200_000,
      ...(m === 'claude-haiku-4-5' ? {} : { maxOutputTokens: 32_000 }),
    });
    models.remote = entry(r.model);
    // Claude Code agent aliases follow the chosen platform.
    models.opus = entry('claude-opus-5');
    models.sonnet = entry('claude-sonnet-5');
    models.haiku = entry('claude-haiku-4-5');
  }

  // Always explicit, so re-running setup replaces a previous mode.
  routing.mode = !a.local ? 'remote-only' : r.kind === 'none' ? 'local-only' : 'auto';
  if (a.budget?.dailyUsd || a.budget?.monthlyUsd) {
    routing.budget = {
      ...(a.budget.dailyUsd ? { dailyUsd: a.budget.dailyUsd } : {}),
      ...(a.budget.monthlyUsd ? { monthlyUsd: a.budget.monthlyUsd } : {}),
    };
  }
  return { providers, models, routing };
}

export interface WriteResult {
  file: string;
  backup?: string;
  config: Record<string, unknown>;
}

/**
 * Merge a layer into a config file (creating it if needed), validating the
 * result against the schema first. Existing files are backed up to `.bak`
 * because rewriting drops comments.
 */
export function writeConfigLayer(file: string, layer: Record<string, unknown>): WriteResult {
  let existing: Record<string, unknown> = {};
  let backup: string | undefined;
  if (existsSync(file)) {
    existing = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  const merged = deepMerge(existing, layer);
  const check = HarnessConfig.safeParse(deepMerge(defaultConfig(), merged));
  const problem = check.success
    ? referenceProblem(check.data)
    : check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  if (problem) throw new Error(`setup produced an invalid config: ${problem}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return { file, ...(backup ? { backup } : {}), config: merged };
}
