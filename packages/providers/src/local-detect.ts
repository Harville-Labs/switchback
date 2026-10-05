/**
 * Discover local model servers and what they report about their models:
 * available models, tool-calling support, and the context window the server
 * will actually load. Used by `switchback init` and, at runtime, to fill in a
 * local model's context window when config leaves it out.
 */

import { parseModelList } from './model-list.ts';

export type LocalServerKind =
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'sglang'
  | 'koboldcpp'
  | 'jan'
  | 'openai-compatible';

export interface DetectedModel {
  id: string;
  /** Context the server will actually use, when it reports one. */
  contextWindow?: number;
  /** The model's maximum context, which may exceed what the server loads. */
  maxContext?: number;
  /** Where contextWindow came from, for diagnostics. */
  contextSource?: string;
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
  { kind: 'sglang', label: 'SGLang', origin: 'http://localhost:30000' },
  { kind: 'koboldcpp', label: 'KoboldCpp', origin: 'http://localhost:5001' },
  { kind: 'jan', label: 'Jan', origin: 'http://localhost:1337' },
];

/** Ollama loads models with this context unless num_ctx or OLLAMA_CONTEXT_LENGTH say otherwise. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;

type Fetch = typeof fetch;

/** Credentials and extra headers for servers that require them (`--api-key`). */
type ServerHeaders = Record<string, string>;

async function getJson(
  fetchImpl: Fetch,
  url: string,
  init?: RequestInit & { headers?: ServerHeaders },
): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function detectOllama(
  fetchImpl: Fetch,
  origin: string,
  env: Record<string, string | undefined>,
  headers: ServerHeaders = {},
): Promise<DetectedServer> {
  const tags = (await getJson(fetchImpl, `${origin}/api/tags`, { headers })) as {
    models?: { name: string }[];
  };
  const envCtx = Number(env.OLLAMA_CONTEXT_LENGTH) || undefined;
  const models = await Promise.all(
    (tags.models ?? []).slice(0, 30).map(async ({ name }): Promise<DetectedModel> => {
      try {
        const show = (await getJson(fetchImpl, `${origin}/api/show`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
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
          contextSource: numCtx
            ? 'Ollama num_ctx'
            : envCtx
              ? 'OLLAMA_CONTEXT_LENGTH'
              : `Ollama default (${OLLAMA_DEFAULT_CONTEXT})`,
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
  serverLabel: string,
  origin: string,
  headers: ServerHeaders = {},
): Promise<DetectedServer> {
  let label = serverLabel;
  const models: DetectedModel[] = parseModelList(
    await getJson(fetchImpl, `${origin}/v1/models`, { headers }),
  ).map((m) => ({
    id: m.id,
    ...(m.contextWindow ? { contextWindow: m.contextWindow, contextSource: m.contextSource } : {}),
    ...(m.tools !== undefined ? { tools: m.tools } : {}),
  }));
  const setAll = (contextWindow: number, contextSource: string) => {
    for (const m of models) Object.assign(m, { contextWindow, contextSource });
  };
  // Server-specific endpoints are tried whatever the port suggests; unknown ones just 404.
  // LM Studio's REST API reports loaded and maximum context per model.
  try {
    const rich = (await getJson(fetchImpl, `${origin}/api/v0/models`, { headers })) as {
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
      const window = r.loaded_context_length ?? r.max_context_length;
      if (window) {
        m.contextWindow = window;
        m.contextSource = 'LM Studio /api/v0/models';
      }
      if (r.max_context_length) m.maxContext = r.max_context_length;
    }
  } catch {
    // Older LM Studio: fall back to the OpenAI listing.
  }
  try {
    const props = (await getJson(fetchImpl, `${origin}/props`, { headers })) as {
      n_ctx?: number;
      default_generation_settings?: { n_ctx?: number };
    };
    const nCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    if (nCtx) setAll(nCtx, 'llama.cpp /props n_ctx');
  } catch {
    // Not every build exposes /props.
  }
  // Text Generation Inference serves one model and reports its token limits.
  try {
    const info = (await getJson(fetchImpl, `${origin}/info`, { headers })) as {
      max_total_tokens?: number;
    };
    if (info.max_total_tokens) {
      setAll(info.max_total_tokens, 'TGI /info max_total_tokens');
      // Port 8080 is llama.cpp's default too.
      label = 'Text Generation Inference';
    }
  } catch {
    // Not TGI.
  }
  // KoboldCpp reports the context it was launched with.
  try {
    const kobold = (await getJson(fetchImpl, `${origin}/api/extra/true_max_context_length`, {
      headers,
    })) as { value?: number };
    if (kobold.value) setAll(kobold.value, 'KoboldCpp true_max_context_length');
  } catch {
    // Not KoboldCpp.
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

/**
 * Ask whichever server is behind `baseUrl` what context it loads for `model`.
 * Tries Ollama's API, then the model listing and the server-specific endpoints
 * of LM Studio, llama.cpp, TGI, and KoboldCpp; returns undefined
 * when none answer.
 */
export async function probeContextWindow(
  baseUrl: string,
  model: string,
  options: {
    fetch?: Fetch;
    env?: Record<string, string | undefined>;
    headers?: ServerHeaders;
  } = {},
): Promise<{ contextWindow: number; source: string } | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const headers = options.headers ?? {};
  const origin = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const attempts = [
    () => detectOllama(fetchImpl, origin, env, headers),
    () => detectOpenAICompatible(fetchImpl, 'openai-compatible', origin, origin, headers),
  ];
  for (const attempt of attempts) {
    try {
      const found = (await attempt()).models.find((m) => m.id === model);
      if (found?.contextWindow)
        return { contextWindow: found.contextWindow, source: found.contextSource ?? origin };
    } catch {
      // Not this kind of server; try the next.
    }
  }
  return undefined;
}
