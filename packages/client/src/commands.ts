/**
 * Slash commands, shared by both clients so the TUI's /help and the VS Code
 * command menu list the same things. Each client runs a command its own way
 * (the TUI prints, VS Code may open a picker); this is only the catalog.
 * Custom commands (Markdown files the engine lists with `commands.list`) join
 * it in the `Custom` group; a client sends one as a prompt and the engine
 * expands it.
 */
import type { CustomCommandInfo } from '@switchback/protocol';
import { ROUTES } from './modes.ts';

export type ClientName = 'tui' | 'vscode';

export type CommandGroup =
  | 'Routing'
  | 'Session'
  | 'Permissions'
  | 'Models'
  | 'Usage'
  | 'Tools'
  | 'Extension'
  | 'Custom';

export interface SlashCommand {
  name: string;
  /** Argument hint shown after the name, e.g. `<name>` or `[rule|agent|model]`. */
  args?: string;
  description: string;
  group: CommandGroup;
  /** Clients that implement it; omitted means both. */
  clients?: readonly ClientName[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  ...ROUTES.map((r) => ({ name: r.value, group: 'Routing' as const, description: r.description })),
  {
    name: 'up',
    group: 'Routing',
    description: 'escalate: a stronger model takes over now, or from the next prompt',
  },
  { name: 'new', group: 'Session', description: 'start a new session' },
  {
    name: 'agent',
    args: '[name]',
    group: 'Session',
    description: 'start a new session with an agent',
  },
  { name: 'agents', group: 'Session', description: 'list agents' },
  {
    name: 'tab',
    args: '[n|new [agent]|close]',
    group: 'Session',
    description: 'switch to a tab, open a new one, or close this one (it keeps running)',
  },
  {
    name: 'tabs',
    group: 'Session',
    description: 'every session: open tabs, and ones working in other windows (ctrl+t)',
  },
  { name: 'sessions', group: 'Session', description: 'list saved sessions in this workspace' },
  {
    name: 'resume',
    args: '[n|id]',
    group: 'Session',
    description: 'switch to a saved session (no argument: pick from a list)',
  },
  {
    name: 'rename',
    args: '[title]',
    group: 'Session',
    description: 'rename this session (no argument: show its title)',
  },
  {
    name: 'compact',
    group: 'Session',
    description: 'summarize earlier messages now (also automatic)',
  },
  {
    name: 'autocompact',
    args: '[on|off] [--save]',
    group: 'Session',
    description: 'turn automatic compaction on or off; --save keeps it for new sessions',
  },
  {
    name: 'rewind',
    group: 'Session',
    description: 'go back to before a prompt: files, the conversation, or both',
  },
  { name: 'subagents', group: 'Session', description: "list this session's subagents as a tree" },
  {
    name: 'goal',
    args: '[objective|stop]',
    group: 'Session',
    description: 'keep working, turn after turn, until the objective is met; no argument shows it',
  },
  {
    name: 'subagent',
    args: '[n]',
    group: 'Session',
    description: 'show what a subagent did: routes, tools, report',
    clients: ['tui'],
  },
  {
    name: 'effort',
    args: '[none|low|medium|high|xhigh|max|default]',
    group: 'Routing',
    description: "how hard this session's models reason; default follows the agent and models",
  },
  {
    name: 'mode',
    args: '[default|accept-edits|auto-approve|plan|bypass]',
    group: 'Permissions',
    description: 'how tool calls are approved in this session (Shift+Tab cycles)',
  },
  {
    name: 'permissions',
    group: 'Permissions',
    description: 'the mode, permission levels, and every rule with its source',
  },
  {
    name: 'models',
    args: '[refresh]',
    group: 'Models',
    description: 'configured models, their tier, and their roles; refresh asks endpoints again',
  },
  {
    name: 'roles',
    args: '[reset]',
    group: 'Models',
    description: 'which model does what in this session; reset follows config',
  },
  {
    name: 'current',
    args: '[model...]',
    group: 'Models',
    description: 'the current model: no argument picks from a list (more models are backups)',
  },
  {
    name: 'model',
    args: '[model]',
    group: 'Models',
    description:
      "the model for what's in front: /current, or the subagent model in a subagent's view",
    clients: ['tui'],
  },
  {
    name: 'ladder',
    args: '[<step...>|none]',
    group: 'Models',
    description:
      'the escalation ladder (no argument: edit it); a step is a model, or a,b alternatives',
  },
  {
    name: 'review',
    args: 'on|off|default|ladder|with <model...>',
    group: 'Models',
    description: 'review of edits, and who reviews: the ladder, or models in order',
  },
  {
    name: 'subagent-model',
    args: '[model|none]',
    group: 'Models',
    description: 'default model for subagents',
  },
  {
    name: 'usage',
    args: '[rule|agent|model]',
    group: 'Usage',
    description: "this week's spend, savings, and why",
  },
  { name: 'receipt', group: 'Usage', description: "this session's cost vs. running it all-remote" },
  { name: 'mcp', group: 'Tools', description: 'MCP servers and their tools' },
  {
    name: 'worktrees',
    args: '[branch]',
    group: 'Tools',
    description: "branches isolated subagents made, or one branch's diff",
  },
  {
    name: 'shells',
    args: '[kill <id>]',
    group: 'Tools',
    description: 'background shells (dev servers, watchers); kill stops one',
  },
  {
    name: 'copy',
    args: '[n|tool|all]',
    group: 'Tools',
    description: 'copy the last reply, its nth code block, the last tool output, or everything',
  },
  {
    name: 'reload',
    group: 'Tools',
    description: 'read the config files again and apply them',
  },
  { name: 'help', group: 'Tools', description: 'list commands' },
  {
    name: 'theme',
    args: '[dark|light|plain]',
    group: 'Extension',
    description: 'colors for the terminal UI',
    clients: ['tui'],
  },
  {
    name: 'mouse',
    args: '[on|off]',
    group: 'Extension',
    description: 'mouse wheel and tab clicks, or plain drag to select text (off)',
    clients: ['tui'],
  },
  {
    name: 'init',
    group: 'Models',
    description: 'set up models and providers, as switchback init does',
  },
  { name: 'logs', group: 'Extension', description: 'show engine logs', clients: ['vscode'] },
  { name: 'restart', group: 'Extension', description: 'restart the engine', clients: ['vscode'] },
  { name: 'exit', group: 'Extension', description: 'quit', clients: ['tui'] },
];

/**
 * Custom commands as menu entries. A built-in command keeps its name: a
 * custom one that reuses it is left out, since the client would run the
 * built-in anyway.
 */
export function customCommands(infos: readonly CustomCommandInfo[]): SlashCommand[] {
  const builtin = new Set(SLASH_COMMANDS.map((c) => c.name));
  return infos
    .filter((c) => !builtin.has(c.name))
    .map((c) => ({
      name: c.name,
      ...(c.args ? { args: c.args } : {}),
      description: `${c.description} (${c.source})`,
      group: 'Custom' as const,
    }));
}

/** Whether a prompt runs a custom command (`/name args`), so it goes to the engine as a prompt. */
export function isCustomCommand(text: string, custom: readonly SlashCommand[]): boolean {
  const name = /^\/(\S+)/.exec(text.trim())?.[1];
  return !!name && custom.some((c) => c.name === name);
}

/** The client's commands, its own first and then the custom ones. */
export function commandsFor(
  client: ClientName,
  custom: readonly SlashCommand[] = [],
): SlashCommand[] {
  return [...SLASH_COMMANDS.filter((c) => !c.clients || c.clients.includes(client)), ...custom];
}

/**
 * Commands matching what's typed after `/`: an exact name first, so Enter
 * runs what was typed, then name prefixes, then names that contain the
 * query, in catalog order within each. Descriptions are
 * searched from three characters on; shorter queries match too much prose.
 */
export function matchCommands(
  query: string,
  client: ClientName,
  custom: readonly SlashCommand[] = [],
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const all = commandsFor(client, custom);
  if (!q) return all;
  const prefix = all
    .filter((c) => c.name.startsWith(q))
    .sort((a, b) => Number(b.name === q) - Number(a.name === q));
  const contains = all.filter(
    (c) =>
      !prefix.includes(c) &&
      (c.name.includes(q) || (q.length >= 3 && c.description.toLowerCase().includes(q))),
  );
  return [...prefix, ...contains];
}

/**
 * The command name being typed, while the input is still a bare `/name`
 * (no arguments yet); undefined otherwise. Both clients show their command
 * menu exactly while this is defined.
 */
export function commandQuery(input: string): string | undefined {
  return /^\/(\S*)$/.exec(input)?.[1];
}

/** The command list as aligned text, for /help. */
/** Usages longer than this go on a line of their own in `/help`, and are cut in a command menu. */
export const USAGE_COLUMN = 26;

export function formatCommands(client: ClientName, custom: readonly SlashCommand[] = []): string {
  const rows = commandsFor(client, custom).map((c) => [
    `/${c.name}${c.args ? ` ${c.args}` : ''}`,
    c.description,
  ]);
  // A few usages list every argument; sized to those, the column pushes most descriptions
  // past a terminal's width. Those few get a line of their own instead.
  const longest = Math.max(...rows.map(([usage]) => usage?.length ?? 0));
  const width = Math.min(longest, USAGE_COLUMN) + 2;
  return rows
    .map(([usage = '', text]) =>
      usage.length < width
        ? `  ${usage.padEnd(width)}${text}`
        : `  ${usage}\n  ${' '.repeat(width)}${text}`,
    )
    .join('\n');
}
