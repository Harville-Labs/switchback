/**
 * Every model an OpenAI-compatible endpoint serves (vLLM, Ollama, LM Studio, a
 * team's own server), without re-running setup when one is added. What each
 * endpoint's `GET /models` last listed is cached in Switchback's data folder,
 * refreshed in the background each launch and on `/models refresh`. Hosted
 * vendors aren't asked: their catalog entries cover them, and their lists run
 * to hundreds of models.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { listModels } from '@switchback/providers';
import { z } from 'zod';
import { ModelConfig, type SwitchbackConfig } from './config-schema.ts';
import { switchbackPaths } from './paths.ts';
import { aliasFor } from './setup.ts';
import {
  type ListModels,
  readDiscovered,
  refreshSubscriptionModels,
} from './subscription-models.ts';

type Env = Record<string, string | undefined>;

const Cache = z.record(
  z.string(),
  z.object({
    /** The URL the list came from; a changed `baseUrl` makes it stale. */
    baseUrl: z.string(),
    models: z.array(
      z.object({
        id: z.string().min(1),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      }),
    ),
  }),
);
export type EndpointModels = z.infer<typeof Cache>;

const cacheFile = (env: Env) => `${switchbackPaths(env).dataDir}/endpoint-models.json`;

/** What the endpoints last listed; empty when they never have or the file is unreadable. */
export function readEndpointModels(env: Env): EndpointModels {
  try {
    return Cache.parse(JSON.parse(readFileSync(cacheFile(env), 'utf8')));
  } catch {
    // A missing or damaged cache only means configured models stand alone until the next refresh.
    return {};
  }
}

type Endpoint = Extract<SwitchbackConfig['providers'][string], { type: 'openai-compatible' }>;

function endpoints(config: SwitchbackConfig): [string, Endpoint][] {
  return Object.entries(config.providers).filter(
    (e): e is [string, Endpoint] => e[1].type === 'openai-compatible' && e[1].listModels !== false,
  );
}

/**
 * `config` with the endpoint models it doesn't configure yet, named by
 * `aliasFor` (prefixed with the provider when another model has that name).
 * What the user wrote wins: a model configured under any alias isn't added again.
 */
export function withEndpointModels(
  config: SwitchbackConfig,
  listed: EndpointModels = {},
): SwitchbackConfig {
  const models = { ...config.models };
  for (const [id, provider] of endpoints(config)) {
    const found = listed[id];
    if (!found || found.baseUrl !== provider.baseUrl) continue;
    const configured = new Set(
      Object.values(models)
        .filter((m) => m.provider === id)
        .map((m) => m.model),
    );
    for (const m of found.models) {
      if (configured.has(m.id)) continue;
      const base = aliasFor(m.id);
      const alias = base in models ? `${aliasFor(id)}-${base}` : base;
      if (alias in models) continue;
      models[alias] = ModelConfig.parse({
        provider: id,
        model: m.id,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      });
    }
  }
  return { ...config, models };
}

/** What one endpoint said: the models it lists now that it didn't before, or why it couldn't be asked. */
export interface EndpointRefresh {
  provider: string;
  added: string[];
  removed: string[];
  error?: string;
}

/**
 * Ask each endpoint what it serves now and cache the answer. An endpoint that
 * can't be reached keeps its last list, so a server that's off for the day
 * doesn't take its models with it.
 */
export async function refreshEndpointModels(
  config: SwitchbackConfig,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ changed: boolean; endpoints: EndpointRefresh[] }> {
  const before = readEndpointModels(env);
  const next: EndpointModels = {};
  const report = await Promise.all(
    endpoints(config).map(async ([id, p]): Promise<EndpointRefresh> => {
      const was = before[id]?.baseUrl === p.baseUrl ? before[id].models.map((m) => m.id) : [];
      try {
        const listed = await listModels(p.baseUrl, {
          ...(p.apiKey ? { apiKey: p.apiKey } : {}),
          ...(p.headers ? { headers: p.headers } : {}),
          fetch: fetchImpl,
          timeoutMs: 5_000,
        });
        next[id] = {
          baseUrl: p.baseUrl,
          models: listed.map((m) => ({
            id: m.id,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
          })),
        };
        const now = listed.map((m) => m.id);
        return {
          provider: id,
          added: now.filter((m) => !was.includes(m)),
          removed: was.filter((m) => !now.includes(m)),
        };
      } catch (err) {
        if (before[id]) next[id] = before[id];
        return { provider: id, added: [], removed: [], error: (err as Error).message };
      }
    }),
  );
  if (JSON.stringify(next) === JSON.stringify(before)) return { changed: false, endpoints: report };
  const file = cacheFile(env);
  mkdirSync(dirname(file), { recursive: true });
  // Written whole and renamed, so a config load never reads half a file.
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return { changed: true, endpoints: report };
}

/**
 * Refresh both kinds of discovered models, plans and endpoints, and say what
 * each provider lists now that it didn't before. `changed` means the config
 * should be loaded again.
 */
export async function refreshDiscoveredModels(
  config: SwitchbackConfig,
  env: Env,
  deps: { fetch?: typeof fetch; listPlans?: ListModels } = {},
): Promise<{ changed: boolean; sources: EndpointRefresh[] }> {
  const plansBefore = readDiscovered(env);
  const [plans, endpoints] = await Promise.all([
    refreshSubscriptionModels(config, env, deps.listPlans).catch((err: Error) => err),
    refreshEndpointModels(config, env, deps.fetch),
  ]);
  const plansAfter = readDiscovered(env);
  const sources: EndpointRefresh[] = [];
  for (const [id, p] of Object.entries(config.providers)) {
    if (p.type !== 'claude-code' && p.type !== 'codex') continue;
    if (plans instanceof Error) {
      sources.push({ provider: id, added: [], removed: [], error: plans.message });
      continue;
    }
    const was = (plansBefore[p.type] ?? []).map((m) => m.id);
    const now = (plansAfter[p.type] ?? []).map((m) => m.id);
    sources.push({
      provider: id,
      added: was.length ? now.filter((m) => !was.includes(m)) : [],
      removed: was.filter((m) => !now.includes(m)),
    });
  }
  return {
    changed: plans === true || endpoints.changed,
    sources: [...sources, ...endpoints.endpoints],
  };
}
