/**
 * Every model a subscription covers, without listing them in config. Each
 * Claude Code or Codex provider gets the models its sign-in offers that
 * config doesn't name yet, under the model's ID as alias. What the CLI last
 * reported is cached in Switchback's data folder and refreshed in the
 * background each launch; before the first report, the catalog stands in.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CATALOG, type CatalogModel, catalogModel } from '@switchback/providers';
import { z } from 'zod';
import { ModelConfig, type SwitchbackConfig } from './config-schema.ts';
import { switchbackPaths } from './paths.ts';
import { claudeModels, codexModels, type ListedSubscriptionModel } from './runtimes/model-lists.ts';

type Env = Record<string, string | undefined>;
type SubscriptionKind = 'claude-code' | 'codex';

const FAMILY = { 'claude-code': 'anthropic', codex: 'openai' } as const;
const isSubscriptionKind = (type: string): type is SubscriptionKind => type in FAMILY;

const Listed = z.array(
  z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
  }),
);
const Cache = z.object({
  'claude-code': Listed.optional(),
  codex: Listed.optional(),
});
export type DiscoveredModels = z.infer<typeof Cache>;

const cacheFile = (env: Env) => `${switchbackPaths(env).dataDir}/subscription-models.json`;

/** What the CLIs last reported; empty when they never have or the file is unreadable. */
export function readDiscovered(env: Env): DiscoveredModels {
  try {
    return Cache.parse(JSON.parse(readFileSync(cacheFile(env), 'utf8')));
  } catch {
    // A missing or damaged cache only means the catalog stands in until the next refresh.
    return {};
  }
}

/** What a model looks like configured on a subscription provider. */
function subscriptionModel(
  provider: string,
  m: Pick<CatalogModel, 'id'> & Partial<CatalogModel>,
  billing: 'subscription' | 'api',
): ModelConfig {
  const known = catalogModel(m.id);
  const contextWindow = m.contextWindow ?? known?.contextWindow;
  const maxOutputTokens = m.maxOutputTokens ?? known?.maxOutputTokens;
  return ModelConfig.parse({
    provider,
    model: m.id,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    // The plan covers these turns, so estimates don't show a per-token price.
    ...(billing === 'subscription' ? { price: { input: 0, output: 0 } } : {}),
  });
}

/**
 * `config` with the subscription models it doesn't configure yet. An alias
 * config already uses for something else is left alone: what the user wrote wins.
 */
export function withSubscriptionModels(
  config: SwitchbackConfig,
  discovered: DiscoveredModels = {},
): SwitchbackConfig {
  const models = { ...config.models };
  for (const [id, provider] of Object.entries(config.providers)) {
    if (!isSubscriptionKind(provider.type) || !('billing' in provider)) continue;
    const configured = new Set(
      Object.values(models)
        .filter((m) => m.provider === id)
        .map((m) => m.model),
    );
    const offered = discovered[provider.type] ?? CATALOG[FAMILY[provider.type]].models;
    for (const m of offered)
      if (!configured.has(m.id) && !(m.id in models))
        models[m.id] = subscriptionModel(id, m, provider.billing);
  }
  return { ...config, models };
}

export type ListModels = (
  kind: SubscriptionKind,
  provider: { executable?: string },
) => Promise<ListedSubscriptionModel[] | undefined>;

const listFromCli: ListModels = (kind, provider) =>
  kind === 'codex' ? codexModels(provider) : claudeModels(provider);

/**
 * Ask each configured subscription CLI what it offers now and cache the
 * answer. Resolves to whether anything changed, so the caller reloads config
 * only then.
 */
export async function refreshSubscriptionModels(
  config: SwitchbackConfig,
  env: Env,
  list: ListModels = listFromCli,
): Promise<boolean> {
  const before = readDiscovered(env);
  const next: DiscoveredModels = { ...before };
  const seen = new Set<SubscriptionKind>();
  for (const provider of Object.values(config.providers)) {
    if (!isSubscriptionKind(provider.type) || seen.has(provider.type)) continue;
    seen.add(provider.type);
    const listed = await list(
      provider.type,
      'executable' in provider && provider.executable ? { executable: provider.executable } : {},
    );
    if (listed?.length) next[provider.type] = listed;
  }
  if (JSON.stringify(next) === JSON.stringify(before)) return false;
  const file = cacheFile(env);
  mkdirSync(dirname(file), { recursive: true });
  // Written whole and renamed, so a config load never reads half a file.
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  return true;
}
