/**
 * Slash commands, shared by both clients so the TUI's /help and the VS Code
 * command menu list the same things. Each client runs a command its own way
 * (the TUI prints, VS Code may open a picker); this is only the catalog.
 * Custom commands (Markdown files the engine lists with `commands.list`) join
 * it in the `Custom` group; a client sends one as a prompt and the engine
 * expands it.
 */
import type { CustomCommandInfo } from '@switchback/protocol';

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
  { name: 'auto', group: 'Routing', description: 'start on the start model; escalate when stuck' },
  { name: 'local', group: 'Routing', description: 'only local models for the next prompts' },
  { name: 'remote', group: 'Routing', description: 'only hosted models for the next prompts' },
  {
    name: 'up',
    group: 'Routing',
    description: 'escalate: a stronger model takes over now, or from the next prompt (alt+↑)',
  },
  { name: 'new', group: 'Session', description: 'start a new session' },
  {
    name: 'agent',
    args: '<name>',
    group: 'Session',
    description: 'start a new session with an agent',
  },
  { name: 'agents', group: 'Session', description: 'list agents' },
  { name: 'sessions', group: 'Session', description: 'list saved sessions in this workspace' },
  {
    name: 'resume',
    args: '[n|id]',
    group: 'Session',
    description: 'switch to a saved session (no argument: pick from a list)',
  },
  {
    name: 'compact',
    group: 'Session',
    description: 'summarize earlier messages now (also automatic)',
  },
  {
    name: 'rewind',
    group: 'Session',
    description: 'go back to before a prompt: files, the conversation, or both',
  },
  { name: 'subagents', group: 'Session', description: "list this session's subagents as a tree" },
  {
    name: 'subagent',
    args: '<n>',
    group: 'Session',
    description: 'show what a subagent did: routes, tools, report',
    clients: ['tui'],
  },
  {
    name: 'mode',
    args: '[default|accept-edits|plan|bypass]',
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
    group: 'Models',
    description: 'configured models, their tier, and their roles',
  },
  {
    name: 'roles',
    args: '[reset]',
    group: 'Models',
    description: 'which model does what in this session; reset follows config',
  },
  {
    name: 'start',
    args: '<model...>',
    group: 'Models',
    description: 'where turns start (more models are backups)',
  },
  {
    name: 'escalate',
    args: '<step...>|none',
    group: 'Models',
    description: 'the escalation ladder; a step is a model, or a,b alternatives',
  },
  {
    name: 'review',
    args: 'on|off|default|ladder|with <model...>',
    group: 'Models',
    description: 'review of edits, and who reviews: the ladder, or models in order',
  },
  {
    name: 'subagent-model',
    args: '<model>|none',
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
  { name: 'help', group: 'Tools', description: 'list commands' },
  {
    name: 'theme',
    args: '[dark|light|plain]',
    group: 'Extension',
    description: 'colors for the terminal UI',
    clients: ['tui'],
  },
  { name: 'setup', group: 'Extension', description: 'set up models', clients: ['vscode'] },
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
 * Commands matching what's typed after `/`: name prefixes first, then names
 * that contain the query, in catalog order within each. Descriptions are
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
  const prefix = all.filter((c) => c.name.startsWith(q));
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
export function formatCommands(client: ClientName, custom: readonly SlashCommand[] = []): string {
  const rows = commandsFor(client, custom).map((c) => [
    `/${c.name}${c.args ? ` ${c.args}` : ''}`,
    c.description,
  ]);
  const width = Math.max(...rows.map(([usage]) => usage?.length ?? 0)) + 2;
  return rows.map(([usage, text]) => `  ${usage?.padEnd(width)}${text}`).join('\n');
}
