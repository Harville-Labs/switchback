import type { AgentDefinition } from './agents.ts';

/** The system prompt's sections for AGENTS.md; reminders of later changes name them (ADR 0017). */
export const INSTRUCTION_HEADINGS = {
  user: 'User instructions (every project)',
  project: 'Project instructions',
} as const;

/**
 * Every session gets this, whatever the ladder: roles can change mid-session,
 * and the prompt is frozen at creation (invariant 7).
 */
const ESCALATION = `# Escalating to a stronger model
You are one of several models the user has set up; some are stronger, and may cost money. When the task is beyond you (you keep failing at it, it needs deeper reasoning than you can give, or you are unsure of a change that matters), call the escalate tool with a short reason. Your next step then runs on the next model up, if there is one and the user's settings allow it; the user may be asked first. Don't escalate for routine work or before trying.`;

export interface SystemPromptParts {
  agent: AgentDefinition;
  workspaceRoot: string;
  /** Where the session works: the workspace, or a subagent's worktree. */
  root: string;
  /** The shell the bash tool runs, by name. */
  shell: string;
  /** The user's AGENTS.md, for every project. */
  user?: string;
  /** The project's AGENTS.md. */
  project?: string;
  /** Extra instructions for this session alone (a headless run's `--instructions`). */
  session?: string;
  /** The skills section (names and descriptions; the skill tool loads the rest). */
  skills?: string;
}

/**
 * A session's system prompt, frozen when the session is created (invariant 7):
 * the agent's prompt, the environment, the user's instructions, the
 * project's, any for this session, and the skills it can load. The more
 * specific instructions come later, so they read as overriding the general.
 */
export function systemPrompt({
  agent,
  workspaceRoot,
  root,
  shell,
  user,
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
    ESCALATION,
  ];
  if (user) sections.push(`# ${INSTRUCTION_HEADINGS.user}\n${user.trim()}`);
  if (project) sections.push(`# ${INSTRUCTION_HEADINGS.project}\n${project.trim()}`);
  if (session) sections.push(`# Instructions for this session\n${session.trim()}`);
  if (skills) sections.push(skills);
  return sections.join('\n\n');
}
