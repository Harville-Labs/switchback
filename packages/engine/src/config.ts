/**
 * Layered configuration: built-in defaults <- user (~/.config/harness/config.json)
 * <- project (.harness/config.json). Later layers deep-merge over earlier ones.
 * String values of the form `{env:NAME}` are replaced with the environment
 * variable so secrets never need to live in a config file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { type Price, ProviderConfig } from '@harness/providers';
import { RoutingConfig } from '@harness/router';
import { z } from 'zod';
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
});
export type HarnessConfig = z.infer<typeof HarnessConfig>;

export interface LoadedConfig {
  config: HarnessConfig;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  prices: Record<string, Price>;
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

export function loadConfig(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
  extra: Record<string, unknown>[] = [],
): LoadedConfig {
  const files = [harnessPaths(env).configFile, projectPaths(workspaceRoot).configFile];
  let merged: Record<string, unknown> = defaultConfig();
  const sources: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
    } catch (err) {
      throw new ConfigError(`invalid JSON: ${(err as Error).message}`, file);
    }
    merged = deepMerge(merged, parsed as Record<string, unknown>);
    sources.push(file);
  }
  for (const layer of extra) merged = deepMerge(merged, layer);

  const result = HarnessConfig.safeParse(resolveEnv(merged, env));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`invalid configuration:\n${issues}`, sources.at(-1));
  }
  const config = result.data;
  const problem = referenceProblem(config);
  if (problem) throw new ConfigError(problem, sources.at(-1));
  const prices: Record<string, Price> = {};
  for (const m of Object.values(config.models)) if (m.price) prices[m.model] = m.price;
  return { config, sources, prices };
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

/** Allow `//` and `/* *\/` comments in config files (strings are respected). */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out;
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
