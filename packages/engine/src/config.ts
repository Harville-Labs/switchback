/**
 * Layered configuration: built-in defaults <- user (~/.config/switchback/config.json)
 * <- project (.switchback/config.json). Later layers deep-merge over earlier ones.
 * String values of the form `{env:NAME}` are replaced with the environment
 * variable so secrets never need to live in a config file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { type Price, ProviderConfig } from '@switchback/providers';
import { RoutingConfig } from '@switchback/router';
import { type ParseError, parse as parseJsoncText, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';
import { McpServerConfig, McpServerName } from './mcp/config.ts';
import { isTrusted } from './mcp/trust.ts';
import { applyRestrictions, leafPaths, type OrgPolicy, type OrgStatus } from './org/policy.ts';
import { readCachedPolicy } from './org/store.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import { DEFAULT_TELEMETRY_ENDPOINT } from './telemetry.ts';

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
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
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

export const SwitchbackConfig = z.object({
  $schema: z.string().optional(),
  providers: z.record(z.string(), ProviderConfig).default({}),
  models: z.record(z.string(), ModelConfig).default({}),
  routing: RoutingConfig.prefault({}),
  permissions: z
    .object({
      read: PermissionLevel.default('allow'),
      edit: PermissionLevel.default('ask'),
      bash: PermissionLevel.default('ask'),
      /** Tools from MCP servers; each server can override it with `permission`. */
      mcp: PermissionLevel.default('ask'),
    })
    .prefault({}),
  /** MCP servers whose tools agents can use (`mcp__<server>__<tool>`). Same shape as Claude Code's `.mcp.json`. */
  mcpServers: z.record(McpServerName, McpServerConfig).default({}),
  /** External agent runtimes that agents can run on (`runtime: <name>`); see ADR 0009. */
  runtimes: z
    .record(
      z.string(),
      z.discriminatedUnion('type', [
        z.object({
          type: z.literal('claude-agent-sdk'),
          /** Claude model for the runtime; defaults to Claude Code's own default. */
          model: z.string().optional(),
          maxTurns: z.number().int().positive().optional(),
          /** Path to Claude Code; defaults to `claude` on PATH. */
          executable: z.string().optional(),
        }),
      ]),
    )
    .default({}),
  defaultAgent: z.string().default('build'),
  subagents: z
    .object({
      maxConcurrent: z.number().int().positive().default(4),
      maxDepth: z.number().int().positive().default(2),
      /** Default remote spend per subagent invocation; an agent's `budgetUsd` overrides it. */
      budgetUsd: z.number().nonnegative().optional(),
    })
    .prefault({}),
  /** Hard cap on model calls per user prompt, to stop runaway loops. */
  maxStepsPerTurn: z.number().int().positive().default(50),
  /** Draft locally, review remotely (docs/review.md). */
  review: z
    .object({
      /** `auto`: after a turn in which a local model edited files, a remote model reviews the diff. */
      mode: z.enum(['off', 'auto']).default('off'),
      /** Reviewer model alias; defaults to the first available model in `routing.remote`. */
      model: z.string().optional(),
      /** Reviews per prompt: a `revise` sends findings back to the local model, then reviews again. */
      maxRounds: z.number().int().min(1).max(5).default(2),
    })
    .prefault({}),
  /**
   * Anonymous usage statistics (docs/telemetry.md). Off unless turned on;
   * `DO_NOT_TRACK=1` or `SWITCHBACK_TELEMETRY=0` force it off.
   */
  telemetry: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.url().default(DEFAULT_TELEMETRY_ENDPOINT),
    })
    .prefault({}),
  /** Content that must never reach a remote model (docs/privacy.md). */
  privacy: z
    .object({
      /**
       * Globs, relative to the workspace. Once content from a matching file
       * enters a session, the session stays local. A pattern without a slash
       * matches by file name anywhere (`*.pem`, `.env*`).
       */
      localOnlyPaths: z.array(z.string().min(1)).default([]),
      /**
       * Credentials in what is about to be sent to a remote model: `redact`
       * replaces them with placeholders in the outbound copy, `block` keeps the
       * turn local, `off` sends them as they are.
       */
      secrets: z.enum(['redact', 'block', 'off']).default('redact'),
    })
    .prefault({}),
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
export type SwitchbackConfig = z.infer<typeof SwitchbackConfig>;

export interface LoadedConfig {
  config: SwitchbackConfig;
  /** Files that contributed, lowest precedence first. */
  sources: string[];
  prices: Record<string, Price>;
  /** Present when an organization policy applied. */
  org?: OrgStatus;
  /** Project-defined MCP servers left out until trusted (`switchback mcp trust`). */
  untrustedMcp: { name: string; source: string; definition: unknown }[];
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
  // Claude Code's .mcp.json sits between the user and project files; only its
  // `mcpServers` is read.
  const files: { file: string; project: boolean; only?: 'mcpServers' }[] = [
    { file: switchbackPaths(env).configFile, project: false },
    { file: pp.mcpJson, project: true, only: 'mcpServers' },
    { file: pp.configFile, project: true },
  ];
  /** Where each MCP server's effective definition came from. */
  const mcpSource = new Map<string, { project: boolean; file: string }>();
  const noteMcp = (layer: unknown, project: boolean, file: string) => {
    const servers = (layer as { mcpServers?: unknown } | undefined)?.mcpServers;
    if (servers && typeof servers === 'object')
      for (const name of Object.keys(servers)) mcpSource.set(name, { project, file });
  };
  let merged: Record<string, unknown> = defaultConfig();
  if (org) {
    merged = deepMerge(merged, org.defaults);
    noteMcp(org.defaults, false, 'organization policy');
  }
  const sources: string[] = [];
  for (const { file, project, only } of files) {
    if (!existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonc(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(`invalid JSON at ${(err as Error).message}`, file);
    }
    if (only) parsed = { [only]: parsed[only] ?? {} };
    // A repository may turn telemetry off for its contributors, never on.
    const t = parsed.telemetry as { enabled?: unknown } | undefined;
    if (project && t?.enabled === true) {
      const { enabled: _ignored, ...rest } = t;
      parsed = { ...parsed, telemetry: rest };
    }
    noteMcp(parsed, project, file);
    merged = deepMerge(merged, parsed);
    sources.push(file);
  }
  for (const layer of extra) {
    merged = deepMerge(merged, layer);
    noteMcp(layer, false, 'command line');
  }
  if (org) {
    merged = deepMerge(merged, org.enforced);
    noteMcp(org.enforced, false, 'organization policy');
  }

  // A repository can't run commands on this machine until the user trusts it.
  const untrustedMcp: LoadedConfig['untrustedMcp'] = [];
  const servers = { ...((merged.mcpServers as Record<string, unknown> | undefined) ?? {}) };
  for (const [name, def] of Object.entries(servers)) {
    const source = mcpSource.get(name);
    if (source?.project && !isTrusted(workspaceRoot, name, def, env)) {
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
  return { config, sources, prices, untrustedMcp, ...(orgStatus ? { org: orgStatus } : {}) };
}

/** `DO_NOT_TRACK` (consoledonottrack.com) or `SWITCHBACK_TELEMETRY=0`. */
export function telemetryOptedOut(env: Record<string, string | undefined>): boolean {
  const off = (v: string | undefined) => !!v && !['0', 'false', ''].includes(v.toLowerCase());
  return off(env.DO_NOT_TRACK) || ['0', 'false', 'off'].includes(env.SWITCHBACK_TELEMETRY ?? '');
}

/** Cross-field checks the schema can't express. Returns a message, or undefined when valid. */
export function referenceProblem(config: SwitchbackConfig): string | undefined {
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
