import type { AgentDefinition } from './agents.ts';

/** The system prompt's sections for AGENTS.md; reminders of later changes name them (ADR 0017). */
export const INSTRUCTION_HEADINGS = {
  user: 'User instructions (every project)',
  project: 'Project instructions',
} as const;

/**
 * How to use what Switchback adds to the model's own tools: subagents and
 * their tabs, escalation, the docs and config. Every top-level session gets
 * it, whatever the ladder, since roles can change mid-session and the prompt is
 * frozen at creation (invariant 7). Coding agent CLIs (Claude Code, Codex)
 * get it with each turn, beside the same tools served over MCP.
 */
export function switchbackGuide(delegates: boolean): string {
  const lines = [
    '# Working in Switchback',
    "You are running inside Switchback, a coding agent that routes each step between the user's local and remote models. The user follows your work in its terminal UI or in VS Code. Besides your usual tools, Switchback gives you these:",
  ];
  if (delegates)
    lines.push(
      "- **Subagents (task).** Delegate self-contained work, such as a broad search, an independent change, or a review, to one of Switchback's agents. Each gets a fresh context, its own model, and a tab the user can open to watch it. When the user asks for subagents, use this tool rather than any subagent feature of your own.",
    );
  lines.push(
    "- **Escalation (escalate).** You are one of several models the user has set up; some are stronger, and may cost money. When the task is beyond you (you keep failing at it, it needs deeper reasoning than you can give, or you are unsure of a change that matters), call escalate with a short reason. The work then moves to the next model up, if there is one and the user's settings allow it; the user may be asked first. Don't escalate for routine work or before trying.",
    "- **Switchback itself (docs).** Before you answer a question about Switchback or change its settings (models, routing, budgets, permissions, providers and keys, MCP servers, hooks, agents, skills), read the relevant page with the docs tool. Change settings with set_config, and this session's models and escalation ladder with set_roles; both apply at once. Config files aren't watched: if you edit one directly (when you don't have set_config), tell the user to type /reload to apply it. Don't guess at keys or commands.",
  );
  return lines.join('\n');
}

/** A subagent's parent sees only its last message, and combines it with others'. */
const REPORTING =
  "# Reporting back\nYou are a subagent: another agent gave you this task and will see only your final message. Stay within the files and scope your brief gives you. End with a short report: what you found or changed (with file paths and line numbers), anything you couldn't do, and anything the caller should check. Leave out the steps you took.";

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
  /** Set for a subagent's session: it is told that its last message is its report. */
  subagent?: boolean;
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
  subagent,
}: SystemPromptParts): string {
  const isolated =
    root !== workspaceRoot
      ? '\nYou are working in an isolated git worktree on your own branch. Edit freely; the parent agent decides whether to merge your changes. Do not commit, push, or switch branches.'
      : '';
  const sections = [
    agent.prompt,
    `# Environment\nWorkspace root: ${root}${isolated}\nPlatform: ${process.platform}\nShell for the bash tool: ${shell}\nFile paths in tool calls are relative to the workspace root.`,
    // A subagent needs only to know how to report; 150 of them shouldn't each carry the guide.
    subagent ? REPORTING : switchbackGuide(!agent.tools || agent.tools.includes('task')),
  ];
  if (user) sections.push(`# ${INSTRUCTION_HEADINGS.user}\n${user.trim()}`);
  if (project) sections.push(`# ${INSTRUCTION_HEADINGS.project}\n${project.trim()}`);
  if (session) sections.push(`# Instructions for this session\n${session.trim()}`);
  if (skills) sections.push(skills);
  return sections.join('\n\n');
}
