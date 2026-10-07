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
  type Price,
} from '@switchback/providers';
import { applyEdits, type JSONPath, modify } from 'jsonc-parser';
import {
  deepMerge,
  defaultConfig,
  parseJsonc,
  referenceProblem,
  removedKeyProblem,
  removedKeysIn,
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
  'claude-code',
  'codex',
  'anthropic',
  'openai',
  'deepseek',
  'gemini',
  'bedrock',
  'vertex',
  'anthropic-aws',
  'foundry',
  'azure-openai',
  'openrouter',
  'openai-compatible',
] as const;
export type RemoteKind = (typeof REMOTE_KINDS)[number];

/** Kinds that run a coding agent CLI the user is signed in to; a subscription covers them. */
export const AGENT_CLI_KINDS = ['claude-code', 'codex'] as const;
const isAgentCliKind = (kind: RemoteKind) => (AGENT_CLI_KINDS as readonly string[]).includes(kind);

/** Which catalog a remote kind draws its models from. */
export function catalogFor(kind: RemoteKind): HostedProviderKind | undefined {
  if (kind === 'claude-code') return 'anthropic';
  if (kind === 'codex') return 'openai';
  if (kind === 'bedrock' || kind === 'vertex' || kind === 'anthropic-aws' || kind === 'foundry')
    return 'anthropic';
  if (kind === 'azure-openai') return 'openai';
  if (kind === 'openai-compatible' || kind === 'openrouter') return undefined;
  return kind;
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface LocalAnswer {
  providerId: string;
  baseUrl: string;
  model: string;
  /** Detected or given; left out, the engine asks the server at runtime. */
  contextWindow?: number;
  apiKeyEnv?: string;
}

export type RemoteAnswer =
  | {
      kind: 'anthropic' | 'openai' | 'deepseek' | 'gemini' | 'claude-code' | 'codex';
      model: string;
    }
  | { kind: 'bedrock'; model: string; region: string; profile?: string }
  | { kind: 'vertex'; model: string; projectId: string; region: string }
  | { kind: 'anthropic-aws'; model: string; region: string; workspaceId: string; profile?: string }
  | { kind: 'foundry'; model: string; resource: string }
  /** `model` is the catalog model; `deployment` is what Azure calls it. */
  | {
      kind: 'azure-openai';
      model: string;
      deployment: string;
      resource: string;
      /** Microsoft Entra ID tokens instead of an API key. */
      auth?: 'entra';
    }
  | {
      kind: 'openai-compatible' | 'openrouter';
      model: string;
      baseUrl: string;
      apiKeyEnv?: string;
      /** From the endpoint's model listing, or asked. */
      contextWindow?: number;
      maxOutputTokens?: number;
      price?: Price;
    };

/**
 * Which models do what (ADR 0015), by alias. `review`: `off`, `ladder` (the
 * reviewers are the escalation ladder), or reviewers in order.
 */
export interface Roles {
  start: string[];
  escalate: string[][];
  review: 'off' | 'ladder' | string[][];
  /** Default model for subagents that don't pin one; normal routing when unset. */
  subagents?: string;
}

export interface SetupAnswers {
  /** Local models, in the order chosen. */
  locals: LocalAnswer[];
  /** Hosted models, in the order chosen. */
  remotes: RemoteAnswer[];
  /** Defaults to `defaultRoles(planModels(...))`. */
  roles?: Roles;
  escalationPolicy: 'auto' | 'ask' | 'off';
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

/** A model setup will configure, with the alias it gets. */
export interface PlannedModel {
  alias: string;
  tier: 'local' | 'remote';
  /** The model ID the provider knows it by. */
  model: string;
  /** For people: where it runs or who serves it. */
  where: string;
  contextWindow?: number;
  /** USD per million input tokens, when the catalog knows it. */
  inputPrice?: number;
}

/** `base`, then `base-2`, `base-3`, ... whichever isn't taken. */
function unique(base: string, taken: Record<string, unknown> | Set<string>): string {
  const has = (k: string) => (taken instanceof Set ? taken.has(k) : k in taken);
  if (!has(base)) return base;
  let n = 2;
  while (has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** A readable alias from a model ID: `qwen3-coder:30b` → `qwen3-coder-30b`, `openai/gpt-oss` → `gpt-oss`. */
export function aliasFor(model: string): string {
  const base = model.split('/').pop() ?? model;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'model';
}

/** How setup names each hosted provider: a short name, and what it serves when that helps. */
export const REMOTE_PROVIDERS: Record<RemoteKind, { name: string; detail?: string }> = {
  'claude-code': { name: 'Claude Code', detail: 'your Claude login or subscription' },
  codex: { name: 'Codex', detail: 'your ChatGPT login or subscription' },
  anthropic: { name: 'Anthropic API', detail: 'Claude' },
  openai: { name: 'OpenAI API', detail: 'GPT' },
  deepseek: { name: 'DeepSeek API' },
  gemini: { name: 'Google Gemini API' },
  bedrock: { name: 'Amazon Bedrock', detail: 'Claude' },
  vertex: { name: 'Google Vertex AI', detail: 'Claude' },
  'anthropic-aws': { name: 'Claude Platform on AWS', detail: 'Anthropic-operated, AWS billing' },
  foundry: { name: 'Microsoft Foundry', detail: 'Claude' },
  'azure-openai': { name: 'Azure OpenAI', detail: 'GPT' },
  openrouter: { name: 'OpenRouter', detail: 'hundreds of models, one key' },
  'openai-compatible': {
    name: 'OpenAI-compatible API',
    detail: 'Together, Groq, Fireworks, a gateway, ...',
  },
};

/** The models the answers describe, with their aliases: locals first, then hosted, as chosen. */
export function planModels(a: Pick<SetupAnswers, 'locals' | 'remotes'>): PlannedModel[] {
  const taken = new Set<string>();
  const plan: PlannedModel[] = [];
  for (const l of a.locals) {
    const alias = unique(aliasFor(l.model), taken);
    taken.add(alias);
    plan.push({
      alias,
      tier: 'local',
      model: l.model,
      where: new URL(l.baseUrl).host,
      ...(l.contextWindow ? { contextWindow: l.contextWindow } : {}),
    });
  }
  for (const r of a.remotes) {
    const alias = unique(aliasFor(r.model), taken);
    taken.add(alias);
    const catalog = catalogFor(r.kind);
    const entry = catalog ? CATALOG[catalog].models.find((m) => m.id === r.model) : undefined;
    const compat = r.kind === 'openai-compatible' || r.kind === 'openrouter';
    const contextWindow = compat ? r.contextWindow : entry?.contextWindow;
    // A subscription covers CLI models, so they cost nothing per token here.
    const inputPrice = isAgentCliKind(r.kind) ? 0 : compat ? r.price?.input : entry?.price.input;
    plan.push({
      alias,
      tier: 'remote',
      model: r.kind === 'azure-openai' ? r.deployment : r.model,
      where:
        r.kind === 'openai-compatible' ? new URL(r.baseUrl).host : REMOTE_PROVIDERS[r.kind].name,
      ...(contextWindow ? { contextWindow } : {}),
      ...(inputPrice !== undefined ? { inputPrice } : {}),
    });
  }
  return plan;
}

/**
 * Roles to suggest for a set of models: the first local model starts (the
 * cheapest hosted one with none), the other local models are the first
 * escalation steps in the order chosen, then hosted models from cheapest to
 * most expensive. Review starts off.
 */
export function defaultRoles(models: PlannedModel[]): Roles {
  const locals = models.filter((m) => m.tier === 'local');
  const remotes = models
    .filter((m) => m.tier === 'remote')
    .map((m, i) => ({ m, i }))
    // Unknown prices keep their chosen order, after the known ones.
    .sort(
      (x, y) =>
        (x.m.inputPrice ?? Number.POSITIVE_INFINITY) -
          (y.m.inputPrice ?? Number.POSITIVE_INFINITY) || x.i - y.i,
    )
    .map(({ m }) => m);
  const ordered = [...locals, ...remotes];
  const [first, ...rest] = ordered;
  return {
    start: first ? [first.alias] : [],
    escalate: rest.map((m) => [m.alias]),
    review: 'off',
  };
}

/** Build the config layer described by the answers. */
export function buildSetupConfig(a: SetupAnswers): Record<string, unknown> {
  if (!a.locals.length && !a.remotes.length) {
    throw new Error('configure at least one model, local or hosted');
  }
  const plan = planModels(a);
  const roles = a.roles ?? defaultRoles(plan);
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};

  // One provider per server (several models may share it).
  const localIds = new Map<string, string>();
  for (const [i, l] of a.locals.entries()) {
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
    models[plan[i]?.alias ?? aliasFor(l.model)] = {
      provider: id,
      model: l.model,
      ...(l.contextWindow ? { contextWindow: l.contextWindow } : {}),
    };
  }

  const hostedIds = new Map<string, string>();
  let sizeAliasesFrom: HostedProviderKind | undefined;
  for (const [i, r] of a.remotes.entries()) {
    const alias = plan[a.locals.length + i]?.alias ?? aliasFor(r.model);
    if (r.kind === 'openai-compatible' || r.kind === 'openrouter') {
      let id = hostedIds.get(`compat:${r.baseUrl}`);
      if (!id) {
        id = unique(new URL(r.baseUrl).hostname.split('.').at(-2) ?? 'remote', providers);
        hostedIds.set(`compat:${r.baseUrl}`, id);
        providers[id] = {
          type: 'openai-compatible',
          baseUrl: r.baseUrl,
          tier: 'remote',
          ...(r.apiKeyEnv ? { apiKey: `{env:${r.apiKeyEnv}}` } : {}),
        };
      }
      models[alias] = {
        provider: id,
        model: r.model,
        ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}),
        ...(r.maxOutputTokens ? { maxOutputTokens: r.maxOutputTokens } : {}),
        ...(r.price ? { price: r.price } : {}),
      };
      continue;
    }
    const providerConfig =
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
              : r.kind === 'azure-openai'
                ? {
                    type: 'azure-openai',
                    resource: r.resource,
                    ...(r.auth ? { auth: r.auth } : {}),
                  }
                : { type: r.kind };
    // Several models from the same provider share one provider entry.
    const key = JSON.stringify(providerConfig);
    let id = hostedIds.get(key);
    if (!id) {
      id = unique(r.kind, providers);
      hostedIds.set(key, id);
      providers[id] = providerConfig;
    }
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
      // A subscription covers CLI models: no per-token price, so estimates don't show one.
      ...(isAgentCliKind(r.kind) ? { price: { input: 0, output: 0 } } : {}),
    });
    const chosen = CATALOG[catalog].models.find((m) => m.id === r.model);
    if (r.kind === 'azure-openai') {
      // Requests name the deployment, so the catalog's list price is written out.
      models[alias] = {
        provider: id,
        model: r.deployment,
        ...(chosen
          ? {
              contextWindow: chosen.contextWindow,
              maxOutputTokens: chosen.maxOutputTokens,
              price: chosen.price,
            }
          : {}),
      };
      // Size aliases would need deployments nobody chose.
      continue;
    }
    models[alias] = chosen ? entry(chosen) : { provider: id, model: wire(r.model) };
    // Size aliases (`model: large|medium|small` in agent files) are the first
    // hosted provider's models of that size; they never replace a chosen model's alias.
    if (!sizeAliasesFrom) {
      sizeAliasesFrom = catalog;
      for (const [sizeAlias, m] of Object.entries(aliasModels(catalog)))
        if (!(sizeAlias in models)) models[sizeAlias] = entry(m);
    }
  }

  // Roles must name chosen models.
  const known = new Set(plan.map((m) => m.alias));
  const check = (alias: string, role: string) => {
    if (!known.has(alias))
      throw new Error(`${role} names "${alias}", which isn't one of the chosen models`);
  };
  for (const alias of roles.start) check(alias, 'start');
  for (const step of roles.escalate) for (const alias of step) check(alias, 'escalate');
  if (Array.isArray(roles.review))
    for (const step of roles.review) for (const alias of step) check(alias, 'review');
  if (roles.subagents) check(roles.subagents, 'subagents');

  // Every role is written in full, so re-running setup replaces earlier choices.
  const routing: Record<string, unknown> = {
    start: roles.start,
    escalate: roles.escalate,
    escalation: { policy: a.escalationPolicy },
  };
  if (a.budget?.dailyUsd || a.budget?.monthlyUsd) {
    routing.budget = {
      ...(a.budget.dailyUsd ? { dailyUsd: a.budget.dailyUsd } : {}),
      ...(a.budget.monthlyUsd ? { monthlyUsd: a.budget.monthlyUsd } : {}),
    };
  }
  const review =
    roles.review === 'off'
      ? { mode: 'off', models: [] }
      : { mode: 'auto', models: roles.review === 'ladder' ? [] : roles.review };
  return {
    providers,
    models,
    routing,
    review,
    ...(roles.subagents ? { subagents: { model: roles.subagents } } : {}),
  };
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
export function writeConfigLayer(
  file: string,
  layer: Record<string, unknown>,
  options: {
    /**
     * Check that aliases resolve within this file alone. Off when the caller
     * already checked them against the merged config (models may live in
     * another file, an org policy, or the project config).
     */
    references?: boolean;
    /** Top-level sections to replace whole rather than merge into. */
    replace?: string[];
  } = {},
): WriteResult {
  let text = '{}';
  let backup: string | undefined;
  if (existsSync(file)) {
    text = readFileSync(file, 'utf8');
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  // Keys role-based routing removed (ADR 0015) under a section this layer
  // writes are deleted, so re-running setup migrates an old file instead of
  // failing on it.
  for (const { path } of removedKeysIn(parseJsonc(text)))
    if (path[0] && path[0] in layer) text = applyEdits(text, modify(text, path, undefined, {}));
  for (const key of options.replace ?? [])
    text = applyEdits(text, modify(text, [key], undefined, {}));
  const existing = parseJsonc(text) as Record<string, unknown>;
  const merged = deepMerge(existing, layer);
  const check = SwitchbackConfig.safeParse(deepMerge(defaultConfig(), merged));
  const problem = check.success
    ? (removedKeyProblem(merged) ??
      (options.references === false ? undefined : referenceProblem(check.data)))
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
