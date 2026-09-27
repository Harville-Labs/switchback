import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolSpec } from '@harness/providers';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

/** Which permission setting governs a tool. `none` tools never prompt. */
export type PermissionCategory = 'read' | 'edit' | 'bash' | 'mcp' | 'none';

export interface SubagentResult {
  ok: boolean;
  text: string;
  sessionId: string;
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
    options?: { background?: boolean },
  ) => Promise<SubagentResult>;
  /** Names and descriptions of agents available as subagents. */
  agentCatalog: { name: string; description: string }[];
}

/** What a mutating call would change, for review before approval. */
export interface ToolPreview {
  /** Unified diff, possibly truncated for display. */
  diff: string;
  /** The complete proposed file, for editors that show a real diff. */
  proposed?: { path: string; content: string };
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
  run(input: I, ctx: ToolContext): Promise<string>;
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
 * Resolve a model-supplied path and reject anything outside the workspace,
 * including escapes through symlinks.
 */
export function resolveInWorkspace(root: string, path: string): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, path);
  // Canonicalize the deepest existing ancestor so symlinked dirs cannot escape.
  let existing = target;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const canonical = resolve(realpathSync(existing), relative(existing, target));
  const rel = relative(realRoot, canonical);
  // `relative` uses the platform separator (`..\` on Windows).
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`path "${path}" is outside the workspace`);
  }
  return canonical;
}

export function truncate(text: string, max = 30_000): string {
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
