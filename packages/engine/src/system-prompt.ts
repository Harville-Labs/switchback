import type { AgentDefinition } from './agents.ts';

export interface SystemPromptParts {
  agent: AgentDefinition;
  workspaceRoot: string;
  /** Where the session works: the workspace, or a subagent's worktree. */
  root: string;
  /** The shell the bash tool runs, by name. */
  shell: string;
  /** The project's AGENTS.md. */
  project?: string;
  /** Extra instructions for this session alone (a headless run's `--instructions`). */
  session?: string;
  /** The skills section (names and descriptions; the skill tool loads the rest). */
  skills?: string;
}

/**
 * A session's system prompt, frozen when the session is created (invariant 7):
 * the agent's prompt, the environment, the project's instructions, and any
 * instructions for this session, and the skills it can load.
 */
export function systemPrompt({
  agent,
  workspaceRoot,
  root,
  shell,
  project,
  session,
  skills,
}: SystemPromptParts): string {
  const isolated =
    root !== workspaceRoot
      ? '\nYou are working in an isolated git worktree on your own branch. Edit freely; the parent agent decides whether to merge your changes. Do not commit, push, or switch branches.'
      : '';
  const sections = [
    agent.prompt,
    `# Environment\nWorkspace root: ${root}${isolated}\nPlatform: ${process.platform}\nShell for the bash tool: ${shell}\nFile paths in tool calls are relative to the workspace root.`,
  ];
  if (project) sections.push(`# Project instructions\n${project.trim()}`);
  if (session) sections.push(`# Instructions for this session\n${session.trim()}`);
  if (skills) sections.push(skills);
  return sections.join('\n\n');
}
