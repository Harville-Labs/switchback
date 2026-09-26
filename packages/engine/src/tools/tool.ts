import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ToolSpec } from '@harness/providers';
import { z } from 'zod';

/** Which permission setting governs a tool. `none` tools never prompt. */
export type PermissionCategory = 'read' | 'edit' | 'bash' | 'none';

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
  runSubagent?: (agent: string, prompt: string, description: string) => Promise<SubagentResult>;
  /** Names and descriptions of agents available as subagents. */
  agentCatalog: { name: string; description: string }[];
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  permission: PermissionCategory;
  /** Safe to run concurrently with other non-mutating calls. */
  mutating: boolean;
  /** One-line human summary for permission prompts and UI. */
  summarize(input: I): string;
  run(input: I, ctx: ToolContext): Promise<string>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<z.infer<S>> & { schema: S }): Tool {
  return tool as unknown as Tool;
}

export function toolSpec(tool: Tool, ctx?: Pick<ToolContext, 'agentCatalog'>): ToolSpec {
  const schema = z.toJSONSchema(tool.schema, { target: 'draft-7' }) as Record<string, unknown>;
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
  if (rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)) {
    throw new ToolError(`path "${path}" is outside the workspace`);
  }
  return canonical;
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return `${head}\n\n[truncated ${text.length - max} characters]`;
}
