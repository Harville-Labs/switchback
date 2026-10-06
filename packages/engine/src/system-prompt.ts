import type { AgentDefinition } from './agents.ts';

/**
 * A session's system prompt, frozen when the session is created (invariant 7):
 * the agent's prompt, the environment, and the project's instructions.
 */
export function systemPrompt(
  agent: AgentDefinition,
  workspaceRoot: string,
  root: string,
  instructions: string | undefined,
  shell: string,
): string {
  const isolated =
    root !== workspaceRoot
      ? '\nYou are working in an isolated git worktree on your own branch. Edit freely; the parent agent decides whether to merge your changes. Do not commit, push, or switch branches.'
      : '';
  const sections = [
    agent.prompt,
    `# Environment\nWorkspace root: ${root}${isolated}\nPlatform: ${process.platform}\nShell for the bash tool: ${shell}\nFile paths in tool calls are relative to the workspace root.`,
  ];
  if (instructions) sections.push(`# Project instructions\n${instructions.trim()}`);
  return sections.join('\n\n');
}
