/**
 * What an OpenAI-compatible `GET /models` says about each model. The listing's
 * required fields are only `id` and `object`; servers and gateways add their
 * own, under different names, and this reads the common ones.
 */
import type { Price } from './pricing.ts';

export interface ListedModel {
  id: string;
  /** Context the endpoint reports, when it reports one. */
  contextWindow?: number;
  /** Which field it came from, for diagnostics. */
  contextSource?: string;
  maxOutputTokens?: number;
  /** USD per million tokens, when the listing carries prices. */
  price?: Price;
  /** Whether the endpoint says the model takes tools; undefined when it doesn't say. */
  tools?: boolean;
}

/** Context-length fields by who uses them. The first one present wins. */
const CONTEXT_FIELDS = [
  'max_model_len', // vLLM, SGLang
  'context_length', // OpenRouter, Together
  'context_window', // Groq
] as const;

const positive = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;

/** OpenRouter's prices are decimal strings in USD per token; a negative one means "varies". */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
    ? Math.round(n * 1e6 * 1e6) / 1e6
    : undefined;
}

export function parseModelList(body: unknown): ListedModel[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw): ListedModel[] => {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string') return [];
    const out: ListedModel = { id: m.id };
    for (const field of CONTEXT_FIELDS) {
      const n = positive(m[field]);
      if (n) {
        out.contextWindow = n;
        out.contextSource = `/models ${field}`;
        break;
      }
    }
    const top = m.top_provider as Record<string, unknown> | undefined;
    const maxOut = positive(top?.max_completion_tokens) ?? positive(m.max_completion_tokens);
    if (maxOut) out.maxOutputTokens = maxOut;
    const pricing = m.pricing as Record<string, unknown> | undefined;
    const input = perMillion(pricing?.prompt);
    const output = perMillion(pricing?.completion);
    if (input !== undefined && output !== undefined) {
      const cacheRead = perMillion(pricing?.input_cache_read);
      const cacheWrite = perMillion(pricing?.input_cache_write);
      out.price = {
        input,
        output,
        ...(cacheRead ? { cacheRead } : {}),
        ...(cacheWrite ? { cacheWrite } : {}),
      };
    }
    if (Array.isArray(m.supported_parameters)) out.tools = m.supported_parameters.includes('tools');
    return [out];
  });
}

/** Fetch and parse `GET {baseUrl}/models`. Throws on HTTP errors so callers can report them. */
export async function listModels(
  baseUrl: string,
  options: {
    apiKey?: string;
    headers?: Record<string, string>;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<ListedModel[]> {
  const res = await (options.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      ...options.headers,
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${baseUrl}/models`);
  return parseModelList(await res.json());
}
