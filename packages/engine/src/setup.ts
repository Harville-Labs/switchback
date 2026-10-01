/**
 * Config setup: turn setup answers into a config layer. Server detection
 * lives in @switchback/providers (it's also used at runtime). Used by `switchback init`; kept here (not in the CLI) so any
 * client can drive setup through the same logic.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  aliasModels,
  CATALOG,
  type CatalogModel,
  type HostedProviderKind,
} from '@switchback/providers';
import { applyEdits, type JSONPath, modify } from 'jsonc-parser';
import {
  deepMerge,
  defaultConfig,
  parseJsonc,
  referenceProblem,
  SwitchbackConfig,
} from './config.ts';

export {
  type DetectedModel,
  type DetectedServer,
  detectLocalServers,
  KNOWN_SERVERS,
  type LocalServerKind,
  OLLAMA_DEFAULT_CONTEXT,
} from '@switchback/providers';

// ---------------------------------------------------------------------------
// Answers -> config
// ---------------------------------------------------------------------------

/** Hosted providers setup offers, in the order shown. All are treated the same. */
export const REMOTE_KINDS = [
  'anthropic',
  'openai',
  'deepseek',
  'gemini',
  'bedrock',
  'vertex',
  'anthropic-aws',
  'foundry',
  'openai-compatible',
] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

/** Which catalog a remote kind draws its models from. */
export function catalogFor(kind: RemoteKind): HostedProviderKind | undefined {
  if (kind === 'bedrock' || kind === 'vertex' || kind === 'anthropic-aws' || kind === 'foundry')
    return 'anthropic';
  if (kind === 'openai-compatible') return undefined;
  return kind;
}

export interface LocalAnswer {
  providerId: string;
  baseUrl: string;
  model: string;
  contextWindow: number;
  apiKeyEnv?: string;
}

export type RemoteAnswer =
  | { kind: 'anthropic' | 'openai' | 'deepseek' | 'gemini'; model: string }
  | { kind: 'bedrock'; model: string; region: string; profile?: string }
  | { kind: 'vertex'; model: string; projectId: string; region: string }
  | { kind: 'anthropic-aws'; model: string; region: string; workspaceId: string; profile?: string }
  | { kind: 'foundry'; model: string; resource: string }
  | {
      kind: 'openai-compatible';
      model: string;
      baseUrl: string;
      apiKeyEnv?: string;
      contextWindow: number;
    };

export interface SetupAnswers {
  /** Local models in order of preference: later ones take over when earlier ones are down or too small. */
  locals: LocalAnswer[];
  /** Remote providers in order of preference: later ones are fallbacks. */
  remotes: RemoteAnswer[];
  escalationPolicy: 'auto' | 'ask' | 'off';
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

/** `base`, then `base-2`, `base-3`, ... whichever isn't taken. */
function unique(base: string, taken: Record<string, unknown>): string {
  if (!(base in taken)) return base;
  let n = 2;
  while (`${base}-${n}` in taken) n++;
  return `${base}-${n}`;
}

/** Build the config layer described by the answers. */
export function buildSetupConfig(a: SetupAnswers): Record<string, unknown> {
  if (!a.locals.length && !a.remotes.length) {
    throw new Error('configure at least a local model or a remote provider');
  }
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};
  const routing: Record<string, unknown> = { escalation: { policy: a.escalationPolicy } };

  // One provider per server (several models may share it), one alias per model.
  const localIds = new Map<string, string>();
  const localAliases: string[] = [];
  for (const l of a.locals) {
    let id = localIds.get(l.baseUrl);
    if (!id) {
      id = unique(l.providerId, providers);
      localIds.set(l.baseUrl, id);
      providers[id] = {
        type: 'openai-compatible',
        baseUrl: l.baseUrl,
        tier: 'local',
        ...(l.apiKeyEnv ? { apiKey: `{env:${l.apiKeyEnv}}` } : {}),
      };
    }
    const alias = localAliases.length ? `local-${localAliases.length + 1}` : 'local';
    models[alias] = { provider: id, model: l.model, contextWindow: l.contextWindow };
    localAliases.push(alias);
  }

  const remoteAliases: string[] = [];
  for (const r of a.remotes) {
    const alias = remoteAliases.length ? `remote-${remoteAliases.length + 1}` : 'remote';
    remoteAliases.push(alias);
    if (r.kind === 'openai-compatible') {
      const id = unique('remote', providers);
      providers[id] = {
        type: 'openai-compatible',
        baseUrl: r.baseUrl,
        tier: 'remote',
        ...(r.apiKeyEnv ? { apiKey: `{env:${r.apiKeyEnv}}` } : {}),
      };
      models[alias] = { provider: id, model: r.model, contextWindow: r.contextWindow };
      continue;
    }
    const id = unique(r.kind, providers);
    providers[id] =
      r.kind === 'bedrock'
        ? { type: 'bedrock', region: r.region, ...(r.profile ? { profile: r.profile } : {}) }
        : r.kind === 'vertex'
          ? { type: 'vertex', projectId: r.projectId, region: r.region }
          : r.kind === 'anthropic-aws'
            ? {
                type: 'anthropic-aws',
                region: r.region,
                workspaceId: r.workspaceId,
                ...(r.profile ? { profile: r.profile } : {}),
              }
            : r.kind === 'foundry'
              ? { type: 'foundry', resource: r.resource }
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
    models[alias] = chosen ? entry(chosen) : { provider: id, model: wire(r.model) };
    // Agent aliases (`model: opus|sonnet|haiku`) mean large/medium/small on the
    // first (preferred) remote provider.
    if (remoteAliases.length === 1)
      for (const [tierAlias, m] of Object.entries(aliasModels(catalog)))
        models[tierAlias] = entry(m);
  }

  // Always explicit, so re-running setup replaces a previous mode and chains.
  routing.mode = !a.locals.length ? 'remote-only' : !a.remotes.length ? 'local-only' : 'auto';
  if (localAliases.length) routing.local = localAliases;
  if (remoteAliases.length) routing.remote = remoteAliases;
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

/** Each leaf of a layer as a JSON path; arrays and empty objects are leaves. */
function leaves(layer: Record<string, unknown>, prefix: JSONPath = []): [JSONPath, unknown][] {
  return Object.entries(layer).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length
      ? leaves(v as Record<string, unknown>, [...prefix, k])
      : [[[...prefix, k], v] as [JSONPath, unknown]],
  );
}

/**
 * Merge a layer into a config file (creating it if needed), validating the
 * result against the schema first. Edits are applied in place, so the user's
 * comments and formatting survive; the previous file is still kept as `.bak`.
 */
export function writeConfigLayer(file: string, layer: Record<string, unknown>): WriteResult {
  let text = '{}';
  let backup: string | undefined;
  if (existsSync(file)) {
    text = readFileSync(file, 'utf8');
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  const existing = parseJsonc(text) as Record<string, unknown>;
  const merged = deepMerge(existing, layer);
  const check = SwitchbackConfig.safeParse(deepMerge(defaultConfig(), merged));
  const problem = check.success
    ? referenceProblem(check.data)
    : check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  if (problem) throw new Error(`setup produced an invalid config: ${problem}`);
  for (const [path, value] of leaves(layer)) {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  return { file, ...(backup ? { backup } : {}), config: merged };
}
