import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ImagePart, SessionRoles, SessionSetRolesParams, Tier } from '@switchback/protocol';
import type { Effort, Price, ToolSpec } from '@switchback/providers';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import type { SwitchbackConfig } from '../config.ts';
import type { Skill } from '../skills.ts';
import type { CommandRunner } from './process.ts';
import type { WebSettings } from './web.ts';

/** Which permission setting governs a tool. `none` tools never prompt. */
export type PermissionCategory = 'read' | 'edit' | 'bash' | 'web' | 'mcp' | 'none';

export interface SubagentResult {
  ok: boolean;
  text: string;
  sessionId: string;
  /** Why the report must stay local: the subagent saw private content. */
  private?: string;
}

/** How the parent wants a delegated task run. */
export interface SubagentOptions {
  background?: boolean;
  isolation?: 'worktree';
  /** A model alias for this task, over the agent's own. */
  model?: string;
  /** Reasoning effort for this task, over the agent's own. */
  effort?: Effort;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  signal: AbortSignal;
  /** Available only to the task tool; undefined when max subagent depth is reached. */
  runSubagent?: (
    agent: string,
    prompt: string,
    description: string,
    options?: SubagentOptions,
  ) => Promise<SubagentResult>;
  /** How many task calls the model made in this step; their reports share one budget. */
  tasksInStep?: number;
  /** Names and descriptions of agents available as subagents. */
  agentCatalog: { name: string; description: string }[];
  /**
   * Whether a deny rule keeps this file (an absolute path) from being read;
   * search tools leave such files out of their results.
   */
  hidden?: (path: string) => boolean;
  /** Search backend and limits for the web tools. */
  web?: WebSettings;
  /** Why this session must stay on this machine, when it must (the web tools refuse then). */
  privateReason?: string;
  /** Runs shell commands, in the foreground or in the background (the bash tools). */
  commands?: CommandRunner;
  /** Ask the user to approve a plan; only top-level sessions have it (exit_plan_mode). */
  approvePlan?: (plan: string) => Promise<PlanAnswer>;
  /** The skills there are now, by name (the skill tool). */
  skills?: () => Map<string, Skill>;
  /** Where this engine's config files are, absolute (the docs tool). */
  configFiles?: { user: string; project: string; projectLocal: string };
  /**
   * What's wrong with writing `content` to `file` (absolute), or undefined
   * when nothing is: Switchback's config files must still parse and match
   * the schema. Edit and write check it before asking and before writing.
   */
  validate?: (file: string, content: string) => string | undefined;
  /** Ask the router to move the session's next call up the ladder (the escalate tool). */
  requestEscalation?: (reason: string) => void;
  /** End the session's goal; false when none is active. Only top-level sessions have it (the goal tool). */
  reportGoal?: (status: 'done' | 'blocked', summary: string) => boolean;
  /** Switchback's own models, settings, and this session's roles (tools/switchback.ts). */
  switchback?: SwitchbackControls;
}

/** A configured model as the model tools describe it. */
export interface ModelListing {
  alias: string;
  provider: string;
  model: string;
  tier: Tier;
  contextWindow: number;
  /** False while its provider is failing health checks. */
  available: boolean;
  vision: boolean;
  /** An endpoint lists it, but no config file names it. */
  listed: boolean;
  /** Undefined when the price isn't known; local models are free. */
  price?: Price;
}

export interface SwitchbackControls {
  models(): ModelListing[];
  /** The session's roles: its own changes over the config. */
  roles(): SessionRoles;
  /** The configuration in effect. */
  config(): SwitchbackConfig;
  /** Who enforces settings, and their dotted paths; undefined without an organization. */
  org(): { name: string; enforcedKeys: string[] } | undefined;
  /**
   * Write a config file's new text and apply it. Throws, leaving the file as
   * it was, when the configuration won't load with it. Returns the top-level
   * keys that changed.
   */
  saveConfig(file: string, text: string): string[];
  /** Change the session's roles, as `session.setRoles` does. */
  setRoles(params: Omit<SessionSetRolesParams, 'sessionId'>): SessionRoles & { savedTo?: string };
}

export type PlanAnswer = 'approved' | 'approved-accept-edits' | 'rejected' | 'not-planning';

/** What a mutating call would change, for review before approval. */
export interface ToolPreview {
  /** Unified diff, possibly truncated for display. */
  diff: string;
  /** The complete proposed file, for editors that show a real diff. */
  proposed?: { path: string; content: string };
}

/** A result with images (`read` on an image file); most tools return just text. */
export interface ToolOutput {
  text: string;
  images: ImagePart[];
  /** What an edit changed, as a unified diff: shown to the user, never sent to the model. */
  diff?: string;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  permission: PermissionCategory;
  /** What "always allow" is remembered for; defaults to the category (MCP: per server). */
  permissionKey?: string;
  /** Overrides the configured level for the category (MCP servers' `permission`). */
  permissionLevel?: 'allow' | 'ask' | 'deny';
  /** JSON Schema sent to models, when it doesn't come from `schema` (MCP tools). */
  inputSchema?: Record<string, unknown>;
  /** Safe to run concurrently with other non-mutating calls. */
  mutating: boolean;
  /** One-line human summary for permission prompts and UI. */
  summarize(input: I): string;
  /**
   * What the call would change, as a unified diff, shown in permission
   * prompts. Must not have side effects. Return undefined when there's
   * nothing useful to show; throw ToolError when the call would fail anyway.
   */
  preview?(input: I, ctx: ToolContext): Promise<ToolPreview | undefined>;
  run(input: I, ctx: ToolContext): Promise<string | ToolOutput>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<z.infer<S>> & { schema: S }): Tool {
  return tool as unknown as Tool;
}

export function toolSpec(tool: Tool, ctx?: Pick<ToolContext, 'agentCatalog'>): ToolSpec {
  const schema = tool.inputSchema
    ? { ...tool.inputSchema }
    : (z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<string, unknown>);
  delete schema.$schema;
  let description = tool.description;
  if (tool.name === 'task' && ctx) {
    description += `\n\nAvailable agents:\n${ctx.agentCatalog.map((a) => `- ${a.name}: ${a.description}`).join('\n')}`;
  }
  return { name: tool.name, description, inputSchema: schema };
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * A path as the workspace sees it: relative, with forward slashes on every
 * OS, so output and transcripts read the same everywhere. Undefined when the
 * path is outside the workspace.
 */
export function toWorkspacePath(root: string, path: string): string | undefined {
  const rel = relative(root, resolve(root, path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * A model-supplied path as the absolute, canonical file it names: `~/` is the
 * home directory, relative paths start at `root`, and the deepest existing
 * ancestor is resolved through symlinks, so a symlinked directory can't
 * disguise where a path really goes. Nothing is refused here; whether a path
 * outside the workspace may be used is the permission gate's decision.
 */
export function resolveFile(root: string, path: string, home: string = homedir()): string {
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return canonical(resolve(root, expanded));
}

/** An absolute path with its deepest existing ancestor resolved through symlinks. */
function canonical(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, path));
}

/** Whether an absolute, canonical path is the workspace root or inside it. */
export function insideWorkspace(root: string, file: string): boolean {
  const rel = relative(canonical(resolve(root)), file);
  // `relative` uses the platform separator (`..\\` on Windows).
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Resolve a model-supplied path and reject anything outside the workspace,
 * including escapes through symlinks. For places that must stay inside it
 * (mentions, checkpoints, a skill's files); file tools use `resolveFile` and
 * leave paths outside to the permission gate.
 */
export function resolveInWorkspace(root: string, path: string): string {
  const canonical = resolveFile(root, path);
  if (!insideWorkspace(root, canonical))
    throw new ToolError(`path "${path}" is outside the workspace`);
  return canonical;
}

/** The most any tool result keeps, whatever the model's window. */
export const MAX_RESULT_CHARS = 30_000;

export function truncate(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[truncated ${text.length - max} characters]`;
}

/** Unified diff limited to a readable size for prompts. */
export function diffPreview(path: string, before: string, after: string, maxLines = 400): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, {
    context: 3,
  });
  // Drop the "Index:" / "====" preamble jsdiff emits; keep ---/+++ and hunks.
  const lines = patch.split('\n').filter((l) => !l.startsWith('Index:') && !/^=+$/.test(l));
  while (lines.at(-1) === '') lines.pop();
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more diff lines`;
}
