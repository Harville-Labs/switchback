/**
 * One OpenCode model as a setup answer: where it runs, what Switchback calls
 * it, and the request settings (`body`, a `#variant`) that come with it.
 */
import { openCodeApi } from '@switchback/providers';
import {
  aliasFor,
  type LocalAnswer,
  type ModelSettings,
  OPENROUTER_BASE_URL,
  type RemoteAnswer,
} from '../setup.ts';

type Env = Record<string, string | undefined>;
export type Obj = Record<string, unknown>;

export const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** `{env:NAME}` → `NAME`; anything else isn't an environment reference. */
export const envName = (v: unknown) => /^\{env:([A-Za-z0-9_]+)\}$/.exec(str(v) ?? '')?.[1];

/**
 * Packages that speak the OpenAI API, which is how Switchback reaches a custom
 * endpoint: `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, and the newer
 * `@opencode/ai/providers/openai-compatible`.
 */
const openAiShaped = (npm: string | undefined) => !npm || /\/openai(?:-compatible)?$/.test(npm);

/** One OpenCode model as a setup answer, or why it can't be one. */
export function translateModel(
  pid: string,
  mid: string,
  p: Obj,
  env: Env,
): LocalAnswer | RemoteAnswer | string {
  const opts = obj(p.options);
  const m = obj(obj(p.models)[mid]);
  // The key names the model in OpenCode; `modelID` (or the older `id`) is what the server calls it.
  const model = str(m.modelID) ?? str(m.id) ?? mid;
  const limit = obj(m.limit);
  const contextWindow = num(limit.context);
  const baseUrl = str(opts.baseURL)?.replace(/\/+$/, '');
  const apiKeyEnv = envName(opts.apiKey);

  if (baseUrl) {
    const npm = str(p.npm);
    if (!openAiShaped(npm))
      return `${npm} at a custom URL; Switchback reaches custom endpoints as OpenAI-compatible APIs`;
    if (!URL.canParse(baseUrl)) return `"${baseUrl}" isn't a URL`;
    if (isLocalHost(baseUrl))
      return {
        providerId: aliasFor(pid),
        baseUrl,
        model,
        ...(contextWindow ? { contextWindow } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      };
    const cost = obj(m.cost);
    const price =
      typeof cost.input === 'number' && typeof cost.output === 'number'
        ? { input: cost.input, output: cost.output }
        : undefined;
    return {
      kind: 'openai-compatible',
      model,
      baseUrl,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(num(limit.output) ? { maxOutputTokens: num(limit.output) } : {}),
      ...(price ? { price } : {}),
    };
  }

  switch (pid) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
      return { kind: pid, model };
    case 'google':
      return { kind: 'gemini', model };
    case 'openrouter':
      return {
        kind: 'openrouter',
        model,
        baseUrl: OPENROUTER_BASE_URL,
        apiKeyEnv: apiKeyEnv ?? 'OPENROUTER_API_KEY',
        ...(contextWindow ? { contextWindow } : {}),
      };
    case 'opencode':
    case 'opencode-go':
      if (!openCodeApi(model))
        return "OpenCode serves it on Google's API, which Switchback doesn't use through OpenCode";
      return {
        kind: 'opencode',
        plan: pid === 'opencode' ? 'zen' : 'go',
        model,
        ...(contextWindow ? { contextWindow } : {}),
      };
    case 'amazon-bedrock': {
      // Switchback adds the `anthropic.` prefix itself; cross-region prefixes aren't catalog IDs.
      const bare = model.replace(/^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\./, '');
      if (!bare.startsWith('claude-')) return 'Switchback uses Bedrock for Claude models only';
      return {
        kind: 'bedrock',
        model: bare,
        region: str(opts.region) ?? env.AWS_REGION ?? 'us-east-1',
        ...(str(opts.profile) ? { profile: opts.profile as string } : {}),
      };
    }
    // V2 folds `google-vertex-anthropic` into `google-vertex`; Switchback uses Vertex for Claude.
    case 'google-vertex':
    case 'google-vertex-anthropic': {
      if (!model.startsWith('claude-')) return 'Switchback uses Vertex for Claude models only';
      const projectId =
        str(opts.project) ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCP_PROJECT ?? env.GCLOUD_PROJECT;
      if (!projectId) return 'no Google Cloud project in the config or GOOGLE_CLOUD_PROJECT';
      return {
        kind: 'vertex',
        // Vertex pins versions with `@date`; Switchback's IDs have none.
        model: model.replace(/@.*$/, ''),
        projectId,
        region: str(opts.location) ?? env.VERTEX_LOCATION ?? 'global',
      };
    }
    case 'azure': {
      const resource = str(opts.resourceName) ?? env.AZURE_RESOURCE_NAME;
      if (!resource) return 'no Azure resource name in the config or AZURE_RESOURCE_NAME';
      // OpenCode needs the deployment named after the model.
      return { kind: 'azure-openai', model, deployment: model, resource };
    }
    default:
      return `Switchback has no "${pid}" provider; add it in the next step if it serves an OpenAI-compatible API`;
  }
}

/** Loopback, private networks, `.local`, and bare hostnames: a server on this machine or LAN. */
export function isLocalHost(url: string): boolean {
  const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h.endsWith('.local') ||
    /^(127|10)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    (!h.includes('.') && !h.includes(':'))
  );
}

/** A variant from either format: a list of `{ id, settings }` (or `body`), or a table by name. */
export function variantOf(m: Obj, name: string): Obj | undefined {
  if (Array.isArray(m.variants)) return m.variants.map(obj).find((v) => v.id === name);
  return name in obj(m.variants) ? obj(obj(m.variants)[name]) : undefined;
}

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * A model's request settings in Switchback's terms: `body` (with a variant's
 * merged over it, as OpenCode does) as typed sampling keys where there are
 * some, the rest sent as given, and image input as `vision`. A variant's
 * `settings` (V2) or the keys of a V1 variant are provider options, of which
 * only reasoning effort has a Switchback equivalent.
 */
export function modelSettings(m: Obj, variant?: Obj): ModelSettings | undefined {
  const { temperature, top_p, top_k, ...rest } = { ...obj(m.body), ...obj(variant?.body) };
  const options = { ...variant, ...obj(variant?.settings) };
  const effort = str(options.reasoningEffort) ?? str(options.reasoning_effort);
  const inputs = [obj(m.capabilities).input, obj(m.modalities).input].flatMap((v) =>
    Array.isArray(v) ? v : [],
  );
  const settings: ModelSettings = {
    ...(inputs.includes('image') || m.attachment === true ? { vision: true } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(typeof top_p === 'number' ? { topP: top_p } : {}),
    ...(num(top_k) ? { topK: top_k as number } : {}),
    ...(effort && EFFORTS.has(effort) ? { effort: effort as ModelSettings['effort'] } : {}),
    ...(Object.keys(rest).length ? { body: rest } : {}),
  };
  return Object.keys(settings).length ? settings : undefined;
}
