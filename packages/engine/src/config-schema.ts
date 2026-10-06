/**
 * The configuration file format, validated with Zod (docs/configuration.md).
 * `bun run schema` writes the JSON Schema from it.
 */
import { PermissionMode } from '@switchback/protocol';
import { ProviderConfig } from '@switchback/providers';
import { ModelChain, RoutingConfig } from '@switchback/router';
import { z } from 'zod';
import { McpServerConfig, McpServerName } from './mcp/config.ts';
import { ruleProblem } from './permissions/rules.ts';
import { DEFAULT_TELEMETRY_ENDPOINT } from './telemetry.ts';
import { DEFAULT_DENY_READ } from './tools/sandbox.ts';

export const PermissionLevel = z.enum(['allow', 'ask', 'deny']);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

const PermissionRules = z
  .array(z.string())
  .default([])
  .superRefine((rules, ctx) => {
    const problem = ruleProblem(rules);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

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
      /** The mode new sessions start in (docs/permissions.md). */
      defaultMode: PermissionMode.default('default'),
      /** Rules in Claude Code's syntax. Lists from every layer add up; deny beats ask beats allow. */
      allow: PermissionRules,
      ask: PermissionRules,
      deny: PermissionRules,
    })
    .prefault({}),
  /** How the bash tool runs commands. */
  bash: z
    .object({
      /** Default timeout for a foreground command; a call may ask for up to 10 minutes. */
      timeoutMs: z.number().int().positive().max(600_000).default(120_000),
      /** Added to every command's environment; values may be `{env:NAME}`. */
      env: z.record(z.string(), z.string()).default({}),
      /** A POSIX shell to run commands with instead of the detected one (`/bin/zsh`). */
      shell: z.string().optional(),
      /** OS sandboxing of commands (docs/permissions.md#sandbox). */
      sandbox: z
        .object({
          mode: z.enum(['auto', 'on', 'off']).default('auto'),
          network: z.union([z.enum(['all', 'none']), z.array(z.string())]).default('all'),
          allowWrite: z.array(z.string()).default([]),
          denyRead: z.array(z.string()).default(DEFAULT_DENY_READ),
          denyWrite: z.array(z.string()).default([]),
          allowUnsandboxed: z.boolean().default(true),
        })
        .prefault({}),
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
      /** Model alias for subagents whose agent doesn't pin a model or tier; else normal routing. */
      model: z.string().optional(),
    })
    .prefault({}),
  /** Hard cap on model calls per user prompt, to stop runaway loops. */
  maxStepsPerTurn: z.number().int().positive().default(50),
  /** Review of edits by another model (docs/review.md). */
  review: z
    .object({
      /** `auto`: after a turn in which a model edited files, a reviewer checks the diff. */
      mode: z.enum(['off', 'auto']).default('off'),
      /**
       * Reviewers in order, any models; each entry an alias or a chain of
       * alternatives. The first reviews; if its findings still stand after a
       * fix, the next takes over. Empty: the `routing.escalate` ladder.
       */
      models: z.array(ModelChain).default([]),
      /** Reviews per prompt, across all reviewers. */
      maxRounds: z.number().int().min(1).max(6).default(3),
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
