/**
 * Layered configuration: built-in defaults <- user (~/.config/switchback/config.json)
 * <- project (.switchback/config.json). Later layers deep-merge over earlier ones.
 * String values of the form `{env:NAME}` are replaced with the environment
 * variable so secrets never need to live in a config file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import type { InitializeResult, SessionRoles, Tier } from '@switchback/protocol';
import { isDecisionOnly, type Price, tierOf } from '@switchback/providers';
import { roleAliases } from '@switchback/router';

export { roleAliases } from '@switchback/router';

import { type ParseError, parse as parseJsoncText, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';
import { removedKeyProblem } from './config-removed.ts';
import { SwitchbackConfig } from './config-schema.ts';
import { HookLayers, type SourcedHook } from './hooks/layers.ts';
import {
  applyRestrictions,
  dropMissingPolicyAliases,
  leafPaths,
  type OrgPolicy,
  type OrgStatus,
} from './org/policy.ts';
import { readCachedPolicy } from './org/store.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import { RuleLayers } from './permissions/layers.ts';
import type { SourcedRule } from './permissions/policy.ts';
import { isTrusted } from './trust.ts';

export * from './config-removed.ts';
export * from './config-schema.ts';

export interface LoadedConfig {
  config: SwitchbackConfig;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  prices: Record<string, Price>;
  /** Present when an organization policy applied. */
  org?: OrgStatus;
  /** Project-defined MCP servers left out until trusted (`switchback mcp trust`). */
  untrustedMcp: { name: string; source: string; definition: unknown }[];
  /** Every permission rule in effect, with the layer it came from. */
  rules: SourcedRule[];
  /** Project hooks left out until trusted (`switchback hooks trust`). */
  untrustedHooks: SourcedHook[];
}

/** How rules from an organization's policy are labeled. */
const ORG_SOURCE = 'organization';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Built-in defaults: none. Switchback doesn't pick a model vendor for anyone.
 * `switchback init` writes the providers and models the user chooses, local and
 * remote alike.
 */
export function defaultConfig(): Record<string, unknown> {
  return { providers: {}, models: {} };
}

/**
 * Merge order, lowest first: built-in defaults, org `defaults`, user file,
 * project file, command-line layers, org `enforced`. Org `restrictions` are
 * applied last. By default the org policy is the cached one for the signed-in
 * user; pass `null` to ignore it or a policy to use that one.
 */
export function loadConfig(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
  extra: Record<string, unknown>[] = [],
  org: OrgPolicy | null | undefined = readCachedPolicy(env)?.policy,
): LoadedConfig {
  const pp = projectPaths(workspaceRoot);
  const files: { file: string; project: boolean }[] = [
    { file: switchbackPaths(env).configFile, project: false },
    { file: pp.configFile, project: true },
    { file: pp.localConfigFile, project: true },
  ];
  const rules = new RuleLayers();
  const hookLayers = new HookLayers();
  /** A layer with its rules and hooks taken out, to add up rather than replace. */
  const additive = (
    layer: Record<string, unknown>,
    source: string,
    where: { project?: boolean; org?: boolean } = {},
  ) => hookLayers.take(rules.take(layer, source, where.org), source, where);
  /** Where each MCP server's effective definition came from. */
  const mcpSource = new Map<string, { project: boolean; file: string }>();
  const noteMcp = (layer: unknown, project: boolean, file: string) => {
    const servers = (layer as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (servers && typeof servers === 'object')
      for (const name of Object.keys(servers)) mcpSource.set(name, { project, file });
  };
  let merged: Record<string, unknown> = defaultConfig();
  if (org) {
    const removed = removedKeyProblem(org.defaults) ?? removedKeyProblem(org.enforced);
    if (removed)
      throw new ConfigError(
        `${org.org.name}'s policy uses an old key; ask an administrator to update it: ${removed}`,
      );
    merged = deepMerge(merged, additive(org.defaults, ORG_SOURCE, { org: true }));
    noteMcp(org.defaults, false, 'organization policy');
  }
  const sources: string[] = [];
  for (const { file, project } of files) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonc(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`invalid JSON at ${(err as Error).message}`, file);
    }
    const removed = removedKeyProblem(parsed);
    if (removed) throw new ConfigError(removed, file);
    // A repository may turn telemetry off for its contributors, never on.
    const t = parsed.telemetry as { enabled?: unknown } | undefined;
    if (project && t?.enabled === true) {
      const { enabled: _ignored, ...rest } = t;
      parsed = { ...parsed, telemetry: rest };
    }
    noteMcp(parsed, project, file);
    merged = deepMerge(merged, additive(parsed, sourceLabel(file, workspaceRoot), { project }));
    sources.push(file);
  }
  for (const layer of extra) {
    const removed = removedKeyProblem(layer);
    if (removed) throw new ConfigError(removed);
    merged = deepMerge(merged, additive(layer, 'command line'));
    noteMcp(layer, false, 'command line');
  }
  if (org) {
    merged = deepMerge(merged, additive(org.enforced, ORG_SOURCE, { org: true }));
    noteMcp(org.enforced, false, 'organization policy');
  }
  const ruleSet = rules.result(org ? !org.restrictions.allowUserPermissionRules : false);
  const hookSet = hookLayers.result(
    workspaceRoot,
    env,
    org ? !org.restrictions.allowUserHooks : false,
  );
  merged = {
    ...merged,
    permissions: { ...(merged.permissions as Record<string, unknown>), ...ruleSet.lists },
    hooks: hookSet.hooks,
  };

  // A repository can't run commands on this machine until the user trusts it.
  const untrustedMcp: LoadedConfig['untrustedMcp'] = [];
  const servers = { ...((merged.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  for (const [name, def] of Object.entries(servers)) {
    const source = mcpSource.get(name);
    if (source?.project && !isTrusted(workspaceRoot, `mcp:${name}`, def, env)) {
      delete servers[name];
      untrustedMcp.push({ name, source: source.file, definition: def });
    }
  }
  merged = { ...merged, mcpServers: servers };

  const result = SwitchbackConfig.safeParse(resolveEnv(merged, env));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`invalid configuration:\n${issues}`, sources.at(-1));
  }
  let config = result.data;
  // The environment's opt-out beats every config file, including an org's.
  if (telemetryOptedOut(env))
    config = { ...config, telemetry: { ...config.telemetry, enabled: false } };
  let skipped: string[] = [];
  if (org) ({ config, notes: skipped } = dropMissingPolicyAliases(config, org));
  const problem = referenceProblem(config);
  if (problem) throw new ConfigError(problem, sources.at(-1));
  let orgStatus: OrgStatus | undefined;
  if (org) {
    const restricted = applyRestrictions(config, org);
    config = restricted.config;
    orgStatus = {
      id: org.org.id,
      name: org.org.name,
      version: org.version,
      notes: [
        ...skipped,
        ...restricted.notes,
        ...hookSet.dropped.map(
          (h) => `${h.event} hook from ${h.source} ignored: only organization hooks run`,
        ),
        ...ruleSet.ignored.map(
          (r) =>
            `${r.behavior} rule "${r.rule}" from ${r.source} ignored: only organization rules apply`,
        ),
      ],
      enforcedKeys: leafPaths(org.enforced),
      remoteDisabled: !org.restrictions.allowRemote,
      bypassDisabled: !org.restrictions.allowBypassPermissions,
    };
  }
  const prices: Record<string, Price> = {};
  for (const m of Object.values(config.models)) if (m.price) prices[m.model] = m.price;
  return {
    config,
    sources,
    prices,
    untrustedMcp,
    rules: ruleSet.sourced,
    untrustedHooks: hookSet.untrusted,
    ...(orgStatus ? { org: orgStatus } : {}),
  };
}

/** A config file as people know it: `.switchback/config.json`, `~/.config/switchback/config.json`. */
function sourceLabel(file: string, workspaceRoot: string): string {
  const inProject = relative(workspaceRoot, file);
  if (!inProject.startsWith('..') && !isAbsolute(inProject)) return inProject.split(sep).join('/');
  const home = homedir();
  return file.startsWith(`${home}${sep}`)
    ? `~${file.slice(home.length).split(sep).join('/')}`
    : file;
}

/** `DO_NOT_TRACK` (consoledonottrack.com) or `SWITCHBACK_TELEMETRY=0`. */
export function telemetryOptedOut(env: Record<string, string | undefined>): boolean {
  const off = (v: string | undefined) => !!v && !['0', 'false', ''].includes(v.toLowerCase());
  return off(env.DO_NOT_TRACK) || ['0', 'false', 'off'].includes(env.SWITCHBACK_TELEMETRY ?? '');
}

/** Cross-field checks the schema can't express. Returns a message, or undefined when valid. */
export function referenceProblem(config: SwitchbackConfig): string | undefined {
  for (const [id, pc] of Object.entries(config.providers)) {
    if (pc.type === 'azure-openai' && !pc.resource && !pc.baseUrl)
      return `providers.${id} needs "resource" (your Azure OpenAI resource name) or "baseUrl"`;
  }
  for (const [alias, m] of Object.entries(config.models)) {
    if (!config.providers[m.provider])
      return `models.${alias} references unknown provider "${m.provider}"`;
  }
  // A misspelled alias would silently drop out of its role.
  const { routing } = config;
  const roles: [string, string | undefined][] = [
    ...routing.start.map((a, i): [string, string] => [`routing.start[${i}]`, a]),
    ...routing.escalate.flatMap((step, i) =>
      step.map((a, j): [string, string] => [
        `routing.escalate[${i}]${step.length > 1 ? `[${j}]` : ''}`,
        a,
      ]),
    ),
    ['routing.classifier.model', routing.classifier?.model],
    ...config.review.models.flatMap((step, i) =>
      step.map((a): [string, string] => [`review.models[${i}]`, a]),
    ),
    ['subagents.model', config.subagents.model],
  ];
  for (const [key, alias] of roles) {
    if (!alias) continue;
    const m = config.models[alias];
    if (!m) return `${key} references unknown model "${alias}"; add it under models or remove it`;
    const pc = config.providers[m.provider];
    if (pc && isDecisionOnly(pc) && key !== 'routing.classifier.model')
      return `${key}: "${alias}" is a decision model (${pc.type}), which can only be routing.classifier.model`;
  }
  return undefined;
}

/** Whether a model alias runs locally or remotely, from its provider's config. */
export function tierOfModel(config: SwitchbackConfig, alias: string): Tier | undefined {
  const m = config.models[alias];
  const pc = m && config.providers[m.provider];
  return pc ? tierOf(pc) : undefined;
}

/** The roles the config sets, in the shape a session reports them (nothing overridden). */
export function configRoles(config: SwitchbackConfig): SessionRoles {
  const { routing, review, subagents } = config;
  return {
    start: routing.start,
    escalate: routing.escalate,
    review: { mode: review.mode, models: review.models },
    ...(subagents.model ? { subagents: subagents.model } : {}),
    overridden: [],
  };
}

/** Every configured model, as clients list them. */
export function modelSummaries(config: SwitchbackConfig): InitializeResult['models'] {
  return Object.entries(config.models).map(([alias, m]) => ({
    alias,
    ref: { provider: m.provider, model: m.model },
    tier: tierOfModel(config, alias) ?? 'remote',
  }));
}

export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(b) && isPlainObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function resolveEnv(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, env));
  if (isPlainObject(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, env)]));
  return value;
}

/**
 * Parse a JSONC config file: comments and trailing commas allowed. Errors say
 * where (`line 4, column 12: CommaExpected`).
 */
export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsoncText(text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first) {
    const before = text.slice(0, first.offset);
    const line = before.split('\n').length;
    const column = first.offset - before.lastIndexOf('\n');
    throw new SyntaxError(`line ${line}, column ${column}: ${printParseErrorCode(first.error)}`);
  }
  return value;
}

/** JSON Schema for config files (input shape: everything with a default is optional). */
export function configJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(SwitchbackConfig, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return {
    ...schema,
    title: 'Switchback configuration',
    description:
      'See docs/configuration.md. String values may reference environment variables as {env:NAME}.',
  };
}

/** Copy of a config with secret-looking values replaced, for display. */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /key|token|secret|password/i.test(k) && typeof v === 'string' && v
          ? '<redacted>'
          : redactConfig(v),
      ]),
    );
  }
  return value;
}

/** The model whose prices define "saved": the first remote model in role order. */
export function referenceModel(config: SwitchbackConfig): string | undefined {
  const alias = roleAliases(config.routing).find((a) => tierOfModel(config, a) === 'remote');
  return alias ? config.models[alias]?.model : undefined;
}
