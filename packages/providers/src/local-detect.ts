/**
 * Discover local model servers and what they report about their models:
 * available models, tool-calling support, and the context window the server
 * will actually load. Used by `switchback init` and, at runtime, to fill in a
 * local model's context window when config leaves it out.
 */

export type LocalServerKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'openai-compatible';

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
  label: string,
  origin: string,
): Promise<DetectedServer> {
  const list = (await getJson(fetchImpl, `${origin}/v1/models`)) as {
    data?: { id: string; max_model_len?: number }[];
  };
  const models: DetectedModel[] = (list.data ?? []).map((m) => ({
    id: m.id,
    ...(m.max_model_len
      ? { contextWindow: m.max_model_len, contextSource: '/v1/models max_model_len' }
      : {}),
  }));
  // Server-specific endpoints are tried whatever the port suggests; unknown ones just 404.
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
    const props = (await getJson(fetchImpl, `${origin}/props`)) as {
      n_ctx?: number;
      default_generation_settings?: { n_ctx?: number };
    };
    const nCtx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
    if (nCtx)
      for (const m of models) {
        m.contextWindow = nCtx;
        m.contextSource = 'llama.cpp /props n_ctx';
      }
  } catch {
    // Not every build exposes /props.
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
 * Tries Ollama, LM Studio, llama.cpp, and vLLM APIs in turn; returns undefined
 * when none answer.
 */
export async function probeContextWindow(
  baseUrl: string,
  model: string,
  options: { fetch?: Fetch; env?: Record<string, string | undefined> } = {},
): Promise<{ contextWindow: number; source: string } | undefined> {
  const fetchImpl = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const origin = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const attempts = [
    () => detectOllama(fetchImpl, origin, env),
    () => detectOpenAICompatible(fetchImpl, 'openai-compatible', origin, origin),
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
