/**
 * Config setup: turn setup answers into a config layer. Server detection
 * lives in @harness/providers (it's also used at runtime). Used by `harness init`; kept here (not in the CLI) so any
 * client can drive setup through the same logic.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  aliasModels,
  CATALOG,
  type CatalogModel,
  type HostedProviderKind,
} from '@harness/providers';
import {
  deepMerge,
  defaultConfig,
  HarnessConfig,
  referenceProblem,
  stripJsonComments,
} from './config.ts';

export {
  type DetectedModel,
  type DetectedServer,
  detectLocalServers,
  KNOWN_SERVERS,
  type LocalServerKind,
  OLLAMA_DEFAULT_CONTEXT,
} from '@harness/providers';

// ---------------------------------------------------------------------------
// Answers -> config
// ---------------------------------------------------------------------------

/** Hosted providers setup offers, in the order shown. All are treated the same. */
export const REMOTE_KINDS = [
  'anthropic',
  'openai',
  'deepseek',
  'bedrock',
  'vertex',
  'openai-compatible',
] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

/** Which catalog a remote kind draws its models from. */
export function catalogFor(kind: RemoteKind): HostedProviderKind | undefined {
  if (kind === 'bedrock' || kind === 'vertex') return 'anthropic';
  if (kind === 'openai-compatible') return undefined;
  return kind;
}

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
    | { kind: 'anthropic' | 'openai' | 'deepseek'; model: string }
    | { kind: 'bedrock'; model: string; region: string; profile?: string }
    | { kind: 'vertex'; model: string; projectId: string; region: string }
    | {
        kind: 'openai-compatible';
        model: string;
        baseUrl: string;
        apiKeyEnv?: string;
        contextWindow: number;
      };
  escalationPolicy: 'auto' | 'ask' | 'off';
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

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
  if (r.kind === 'openai-compatible') {
    providers.remote = {
      type: 'openai-compatible',
      baseUrl: r.baseUrl,
      tier: 'remote',
      ...(r.apiKeyEnv ? { apiKey: `{env:${r.apiKeyEnv}}` } : {}),
    };
    models.remote = { provider: 'remote', model: r.model, contextWindow: r.contextWindow };
  } else if (r.kind !== 'none') {
    const id = r.kind;
    providers[id] =
      r.kind === 'bedrock'
        ? { type: 'bedrock', region: r.region, ...(r.profile ? { profile: r.profile } : {}) }
        : r.kind === 'vertex'
          ? { type: 'vertex', projectId: r.projectId, region: r.region }
          : { type: r.kind };
    const catalog = catalogFor(r.kind) as HostedProviderKind;
    // Bedrock model IDs carry the `anthropic.` prefix; everywhere else uses bare IDs.
    const wire = (m: string) => (r.kind === 'bedrock' ? `anthropic.${m}` : m);
    const entry = (m: CatalogModel) => ({
      provider: id,
      model: wire(m.id),
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      // DeepSeek only thinks (and handles tools well) with an effort set.
      ...(catalog === 'deepseek' ? { effort: 'high' } : {}),
    });
    const chosen = CATALOG[catalog].models.find((m) => m.id === r.model);
    models.remote = chosen ? entry(chosen) : { provider: id, model: wire(r.model) };
    // Agent aliases (`model: opus|sonnet|haiku`) mean large/medium/small on the chosen provider.
    for (const [alias, m] of Object.entries(aliasModels(catalog))) models[alias] = entry(m);
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
