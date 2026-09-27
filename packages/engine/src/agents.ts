/**
 * Agent definitions. An agent is a system prompt plus a tool allowlist plus a
 * routing preference. The same definition works as the primary agent of a
 * session or as a subagent spawned through the `task` tool.
 *
 * Definitions are Markdown with YAML frontmatter, in the same format Claude
 * Code uses, so `.claude/agents/*.md` files load unchanged. Lookup order
 * (later wins): built-in, user (~/.config/harness/agents), Claude compat
 * (.claude/agents), project (.harness/agents).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AgentSummary, RoutePreference } from '@harness/protocol';
import { parse as parseYaml } from 'yaml';

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  /** Tool names this agent may use; undefined means all tools. */
  tools?: string[];
  route: RoutePreference;
  /** Model alias pin, e.g. `haiku` or `local`. */
  model?: string;
  /** Remote spend allowed per subagent invocation (including its own subagents). */
  budgetUsd?: number;
  /** Run as a subagent in its own git worktree. */
  isolation?: 'worktree';
  source: AgentSummary['source'];
  file?: string;
}

/** Claude Code tool names mapped to harness tool names. */
const TOOL_ALIASES: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'glob',
  Task: 'task',
  Agent: 'task',
};

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: 'build',
    description: 'Default coding agent with full tool access.',
    prompt:
      "You are a software engineering agent working in the user's repository. Read code before changing it, make focused edits, and verify your work by running the project's checks when possible. Delegate broad searches or independent sub-tasks to subagents with the task tool.",
    route: 'auto',
    source: 'builtin',
  },
  {
    name: 'explore',
    description:
      'Fast read-only search across the codebase. Use for finding files, symbols, and usages; returns a concise summary.',
    prompt:
      'You are a read-only search agent. Find what was asked using glob, grep, and read. Do not modify anything. Reply with a concise summary: the relevant file paths with line numbers and one line on why each matters.',
    tools: ['read', 'glob', 'grep'],
    // Searching is high-volume and low-difficulty: exactly what local models are for.
    route: 'local',
    source: 'builtin',
  },
  {
    name: 'plan',
    description: 'Read-only architect that produces a step-by-step implementation plan.',
    prompt:
      'You are a software architect. Investigate the code with read-only tools and produce a concrete, ordered implementation plan naming the files to change and the risks. Do not modify anything.',
    tools: ['read', 'glob', 'grep'],
    route: 'auto',
    source: 'builtin',
  },
  {
    name: 'general',
    description: 'General-purpose subagent for multi-step tasks that need full tool access.',
    prompt:
      'You are a subagent completing a delegated task. Work autonomously, then reply with a concise report of what you did and found; the report is all the caller will see.',
    route: 'auto',
    source: 'builtin',
  },
];

export function parseAgentFile(
  text: string,
  file: string,
  source: AgentDefinition['source'],
): AgentDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const meta = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === 'string' ? meta.name : basename(file, '.md');
  const description = typeof meta.description === 'string' ? meta.description : '';
  if (!description) throw new Error(`${file}: frontmatter needs a description`);

  let tools: string[] | undefined;
  const rawTools = meta.tools;
  if (typeof rawTools === 'string' || Array.isArray(rawTools)) {
    const list = (Array.isArray(rawTools) ? rawTools : rawTools.split(','))
      .map((t) => String(t).trim())
      .filter(Boolean);
    // MCP tool names (`mcp__server__tool`) are case-sensitive; built-in names aren't.
    tools = [
      ...new Set(
        list.map((t) => (t.startsWith('mcp__') ? t : (TOOL_ALIASES[t] ?? t.toLowerCase()))),
      ),
    ];
  }

  // `model` accepts Claude Code values (sonnet/opus/haiku/inherit), harness tiers
  // (local/remote), or any configured model alias.
  let route: RoutePreference = 'auto';
  let model: string | undefined;
  const rawModel = typeof meta.model === 'string' ? meta.model.trim() : undefined;
  if (rawModel === 'local' || rawModel === 'remote') route = rawModel;
  else if (rawModel && rawModel !== 'inherit') model = rawModel;
  if (meta.route === 'local' || meta.route === 'remote' || meta.route === 'auto')
    route = meta.route;
  let budgetUsd: number | undefined;
  if (meta.budgetUsd !== undefined) {
    budgetUsd = Number(meta.budgetUsd);
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0)
      throw new Error(`${file}: budgetUsd must be a non-negative number of dollars`);
  }

  return {
    name,
    description,
    prompt: (match[2] ?? '').trim(),
    ...(tools ? { tools } : {}),
    route,
    ...(model ? { model } : {}),
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    ...(meta.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
    source,
    file,
  };
}

export interface AgentLoadResult {
  agents: Map<string, AgentDefinition>;
  errors: string[];
}

export function loadAgents(
  dirs: { dir: string; source: AgentDefinition['source'] }[],
): AgentLoadResult {
  const agents = new Map(BUILTIN_AGENTS.map((a) => [a.name, a]));
  const errors: string[] = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const file = join(dir, entry);
      try {
        const agent = parseAgentFile(readFileSync(file, 'utf8'), file, source);
        agents.set(agent.name, agent);
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  return { agents, errors };
}

export function summarize(agent: AgentDefinition): AgentSummary {
  return {
    name: agent.name,
    description: agent.description,
    source: agent.source,
    route: agent.route,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.budgetUsd !== undefined ? { budgetUsd: agent.budgetUsd } : {}),
  };
}
