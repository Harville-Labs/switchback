/**
 * Layered configuration: built-in defaults <- user (~/.config/harness/config.json)
 * <- project (.harness/config.json). Later layers deep-merge over earlier ones.
 * String values of the form `{env:NAME}` are replaced with the environment
 * variable so secrets never need to live in a config file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { type Price, ProviderConfig } from '@harness/providers';
import { RoutingConfig } from '@harness/router';
import { type ParseError, parse as parseJsoncText, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';
import { applyRestrictions, leafPaths, type OrgPolicy, type OrgStatus } from './org/policy.ts';
import { readCachedPolicy } from './org/store.ts';
import { harnessPaths, projectPaths } from './paths.ts';

export const PermissionLevel = z.enum(['allow', 'ask', 'deny']);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const ModelConfig = z.object({
  provider: z.string(),
  model: z.string(),
  /**
   * Tokens the server loads. Optional for local models: the engine asks the
   * server (Ollama, LM Studio, llama.cpp, vLLM) when it's left out.
   */
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().default(16_000),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  price: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
      cacheWrite: z.number().optional(),
    })
    .optional(),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const HarnessConfig = z.object({
  $schema: z.string().optional(),
  providers: z.record(z.string(), ProviderConfig).default({}),
  models: z.record(z.string(), ModelConfig).default({}),
  routing: RoutingConfig.prefault({}),
  permissions: z
    .object({
      read: PermissionLevel.default('allow'),
      edit: PermissionLevel.default('ask'),
      bash: PermissionLevel.default('ask'),
    })
    .prefault({}),
  defaultAgent: z.string().default('build'),
  subagents: z
    .object({
      maxConcurrent: z.number().int().positive().default(4),
      maxDepth: z.number().int().positive().default(2),
    })
    .prefault({}),
  /** Hard cap on model calls per user prompt, to stop runaway loops. */
  maxStepsPerTurn: z.number().int().positive().default(50),
  /** Append-only context compaction (docs/adr/0008-append-only-compaction.md). */
  compaction: z
    .object({
      /** Compact automatically when the prompt passes `threshold`. `session.compact` works either way. */
      enabled: z.boolean().default(true),
      /** Fraction of the largest local window (or the remote window without one) that triggers compaction. */
      threshold: z.number().min(0.2).max(0.95).default(0.7),
      /** Fraction of that window kept verbatim at the end of the conversation. */
      keepRecent: z.number().min(0.05).max(0.6).default(0.25),
    })
    .prefault({}),
});
export type HarnessConfig = z.infer<typeof HarnessConfig>;

export interface LoadedConfig {
  config: HarnessConfig;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  prices: Record<string, Price>;
  /** Present when an organization policy applied. */
  org?: OrgStatus;
}

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
 * Built-in defaults: none. Harness doesn't pick a model vendor for anyone.
 * `harness init` writes the providers and models the user chooses, local and
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
  const files = [harnessPaths(env).configFile, projectPaths(workspaceRoot).configFile];
  let merged: Record<string, unknown> = defaultConfig();
  if (org) merged = deepMerge(merged, org.defaults);
  const sources: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new ConfigError(`invalid JSON at ${(err as Error).message}`, file);
    }
    merged = deepMerge(merged, parsed as Record<string, unknown>);
    sources.push(file);
  }
  for (const layer of extra) merged = deepMerge(merged, layer);
  if (org) merged = deepMerge(merged, org.enforced);

  const result = HarnessConfig.safeParse(resolveEnv(merged, env));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`invalid configuration:\n${issues}`, sources.at(-1));
  }
  let config = result.data;
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
      notes: restricted.notes,
      enforcedKeys: leafPaths(org.enforced),
      remoteDisabled: !org.restrictions.allowRemote,
    };
  }
  const prices: Record<string, Price> = {};
  for (const m of Object.values(config.models)) if (m.price) prices[m.model] = m.price;
  return { config, sources, prices, ...(orgStatus ? { org: orgStatus } : {}) };
}

/** Cross-field checks the schema can't express. Returns a message, or undefined when valid. */
export function referenceProblem(config: HarnessConfig): string | undefined {
  for (const [alias, m] of Object.entries(config.models)) {
    if (!config.providers[m.provider])
      return `models.${alias} references unknown provider "${m.provider}"`;
  }
  return undefined;
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
  const schema = z.toJSONSchema(HarnessConfig, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return {
    ...schema,
    title: 'Harness configuration',
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
