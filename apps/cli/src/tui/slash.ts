/**
 * The TUI's slash commands. The catalog (names, arguments, help) is shared
 * with VS Code through `SLASH_COMMANDS`; this is how the TUI runs each one.
 */
import {
  addInfo,
  childView,
  describeSession,
  escalateNotice,
  formatCommands,
  formatMcpServers,
  formatModels,
  formatPermissions,
  formatReceipt,
  formatRoles,
  formatShells,
  formatSubagents,
  formatUsage,
  formatWorktreeDiff,
  formatWorktrees,
  fromTranscript,
  initialView,
  MODE_DESCRIPTIONS,
  modeLabel,
  parseMode,
  pickCopy,
  type SlashCommand,
  type SwitchbackClient,
  subagentList,
  type ViewState,
} from '@switchback/client';
import type {
  InitializeResult,
  RoutePreference,
  SessionSetRolesParams,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import { copyText } from './clipboard.ts';
import { ago } from './SessionPicker.tsx';
import { THEME_NAMES, type ThemeName } from './theme.ts';

export const helpText = (custom: readonly SlashCommand[]) => `Commands
${formatCommands('tui', custom)}
Role commands take --save to make the change your default.
Input: @ mentions a file (its contents are attached); paste freely: big pastes
       become a chip, dragged-in files become @ mentions; ↑/↓ browse history;
       option/alt+enter, ctrl+j, or a trailing \\ adds a newline.
Keys: during a turn, enter queues a message and esc sends it now (interrupting);
      esc on an empty prompt cancels; ↑ takes back the last queued message;
      shift+tab cycles the permission mode; ctrl+o expands thinking, output, and diffs;
      alt+↑ escalates (a stronger model takes over, like /up);
      PgUp/PgDn or the mouse wheel scroll (hold shift or option to select text);
      prompts: ↑↓ and enter, or the option's number (y/a/p/n still work).
Your own commands are Markdown files in .switchback/commands/ or
~/.switchback/commands/.`;

/** What a command can see and change in the app. */
export interface SlashContext {
  client: SwitchbackClient;
  init: InitializeResult;
  session: SessionSummary;
  view: ViewState;
  setView(update: (v: ViewState) => ViewState): void;
  setSession(s: SessionSummary): void;
  setRoute(route: RoutePreference): void;
  setReview(review: boolean | undefined): void;
  setUsage(u: UsageReport): void;
  /** Custom commands, for /help. */
  custom: readonly SlashCommand[];
  /** Sessions from the last /sessions, for `/resume <n>`. */
  listed: SessionSummary[];
  setListed(sessions: SessionSummary[]): void;
  /** Write raw bytes to the terminal (OSC 52 clipboard). */
  writeRaw(s: string): void;
  /** Show the session picker. */
  openPicker(): Promise<void>;
  /** Show the checkpoint picker. */
  openRewind(): Promise<void>;
  /** The color theme, and a way to change it (saved for next time). */
  theme: ThemeName;
  setTheme(name: ThemeName): void;
  exit(): void;
}

type Handler = (ctx: SlashContext, args: string[]) => Promise<void> | void;

const say = (ctx: SlashContext, text: string) => ctx.setView((v) => addInfo(v, text));

/** Role command arguments without the --save flag. */
const rest = (args: string[]) => args.filter((a) => a && a !== '--save');
const saving = (args: string[]) => args.includes('--save');

async function changeRoles(
  ctx: SlashContext,
  change: Omit<SessionSetRolesParams, 'sessionId'>,
  what: string,
): Promise<void> {
  try {
    const r = await ctx.client.request('session.setRoles', {
      sessionId: ctx.session.id,
      ...change,
    });
    const where = r.savedTo
      ? `Saved as your default in ${r.savedTo}.`
      : 'This session only; add --save to make it your default.';
    ctx.setView((v) =>
      addInfo({ ...v, roles: r }, `${what}\n${formatRoles(r, ctx.init.models)}\n${where}`),
    );
  } catch (err) {
    say(ctx, `roles: ${(err as Error).message}`);
  }
}

/** `/up` and alt+↑: a stronger model takes over (`session.escalate`). */
export async function escalateNow(ctx: SlashContext): Promise<void> {
  try {
    const { when } = await ctx.client.request('session.escalate', { sessionId: ctx.session.id });
    say(ctx, escalateNotice(when));
  } catch (err) {
    say(ctx, `escalate: ${(err as Error).message}`);
  }
}

export async function newSession(ctx: SlashContext, agent?: string): Promise<void> {
  try {
    const s = await ctx.client.request('session.create', agent ? { agent } : {});
    ctx.setSession(s);
    ctx.setView((v) =>
      addInfo({ ...initialView(s.id), items: v.items }, `new session · agent ${s.agent}`),
    );
  } catch (err) {
    say(ctx, (err as Error).message);
  }
}

/** Switch to a saved session: by number from /sessions, by ID, or (with neither) from a picker. */
export async function resume(ctx: SlashContext, which: string | undefined): Promise<void> {
  if (!which) return ctx.openPicker();
  const target = /^\d+$/.test(which) ? ctx.listed[Number(which) - 1]?.id : which;
  if (!target) return say(ctx, `no session ${which} in the last /sessions list`);
  if (target === ctx.session.id) return say(ctx, 'already in that session');
  try {
    const { session: s, messages } = await ctx.client.request('session.get', {
      sessionId: target,
    });
    const history = fromTranscript(s, messages);
    ctx.setSession(s);
    ctx.setView((v) => ({
      ...history,
      items: [
        ...v.items,
        {
          kind: 'info',
          id: `resume-${s.id}-${v.items.length}`,
          text: `── resumed "${s.title || s.id}" ──`,
        },
        ...history.items,
      ],
    }));
  } catch (err) {
    say(ctx, (err as Error).message);
  }
}

async function listSessions(ctx: SlashContext): Promise<void> {
  const all = await ctx.client.request('session.list', {});
  ctx.setListed(all);
  if (!all.length) return say(ctx, 'no saved sessions in this workspace yet');
  const rows = all
    .slice(0, 20)
    .map(
      (x, i) =>
        `${String(i + 1).padStart(2)}. ${x.id === ctx.session.id ? '* ' : ''}${x.title || '(untitled)'}  ${x.agent} · ${ago(x.updatedAt)} · $${x.costUsd.toFixed(3)}`,
    );
  say(ctx, [...rows, '/resume to pick one, or /resume <number>'].join('\n'));
}

function review(ctx: SlashContext, args: string[]): Promise<void> | void {
  if (args[0] === 'ladder' || args[0] === 'with') {
    const models = args[0] === 'ladder' ? [] : rest(args.slice(1)).map((m) => [m]);
    if (args[0] === 'with' && !models.length)
      return say(ctx, 'usage: /review with <model> [next...] [--save]');
    ctx.setReview(true);
    return changeRoles(
      ctx,
      { review: { mode: 'auto', models }, save: saving(args) },
      'Review is on with the new reviewers.',
    );
  }
  const next = args[0] === 'on' ? true : args[0] === 'off' ? false : undefined;
  if (args[0] && args[0] !== 'default' && next === undefined)
    return say(ctx, 'usage: /review on|off|default|ladder|with <model...>');
  ctx.setReview(next);
  say(
    ctx,
    next === undefined
      ? 'review: following review.mode in config'
      : next
        ? 'review: on. After a model edits files, a reviewer checks the diff and the model fixes what it finds (/roles shows who reviews).'
        : 'review: off',
  );
}

async function copy(ctx: SlashContext, args: string[]): Promise<void> {
  const pick = pickCopy(ctx.view.items, args[0]);
  if ('error' in pick) return say(ctx, `copy: ${pick.error}`);
  const native = await copyText(pick.text, ctx.writeRaw);
  const lines = pick.text.split('\n').length;
  say(
    ctx,
    `Copied ${pick.what} (${lines} line${lines === 1 ? '' : 's'})${native ? '' : ' through the terminal (OSC 52); if nothing arrived, your terminal needs clipboard access enabled'}.`,
  );
}

const routeTo =
  (route: RoutePreference): Handler =>
  (ctx) => {
    ctx.setRoute(route);
    say(ctx, `routing: ${route}`);
  };

const HANDLERS: Record<string, Handler> = {
  up: escalateNow,
  local: routeTo('local'),
  remote: routeTo('remote'),
  auto: routeTo('auto'),
  models: async (ctx) => {
    const roles = await ctx.client.request('session.roles', { sessionId: ctx.session.id });
    ctx.setView((v) => addInfo({ ...v, roles }, formatModels(ctx.init.models, roles)));
  },
  roles: async (ctx, args) => {
    if (args[0] === 'reset')
      return changeRoles(ctx, { reset: true }, 'Roles follow your config again.');
    const roles = await ctx.client.request('session.roles', { sessionId: ctx.session.id });
    ctx.setView((v) => addInfo({ ...v, roles }, formatRoles(roles, ctx.init.models)));
  },
  start: (ctx, args) => {
    const models = rest(args);
    if (!models.length) return say(ctx, 'usage: /start <model> [backup...] [--save]');
    return changeRoles(ctx, { start: models, save: saving(args) }, 'Turns start on the new model.');
  },
  escalate: (ctx, args) => {
    const steps = rest(args);
    if (!steps.length) return say(ctx, 'usage: /escalate <model|a,b> ... | none [--save]');
    const escalate = steps[0] === 'none' ? [] : steps.map((step) => step.split(','));
    return changeRoles(ctx, { escalate, save: saving(args) }, 'New escalation ladder.');
  },
  'subagent-model': (ctx, args) => {
    const [model] = rest(args);
    if (!model) return say(ctx, 'usage: /subagent-model <model>|none [--save]');
    return changeRoles(
      ctx,
      { subagents: model === 'none' ? null : model, save: saving(args) },
      'Subagent model changed.',
    );
  },
  review,
  agent: (ctx, args) => newSession(ctx, args[0]),
  agents: async (ctx) => {
    // Asked each time, so agents created meanwhile (switchback agents new) show up.
    const agents = await ctx.client.request('agents.list', {}).catch(() => ctx.init.agents);
    say(
      ctx,
      agents
        .map(
          (a) =>
            `${a.name} [${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}]: ${a.description}`,
        )
        .join('\n'),
    );
  },
  new: (ctx) => newSession(ctx),
  sessions: listSessions,
  resume: (ctx, args) => resume(ctx, args[0]),
  usage: async (ctx, args) => {
    // `/usage` is the weekly picture: where the money went and why.
    const u = await ctx.client.request('usage.get', { period: 'week' });
    const by = (['rule', 'agent', 'model'] as const).find((b) => b === args[0]) ?? 'rule';
    say(ctx, formatUsage(u, by));
    ctx.client.request('usage.get', {}).then(ctx.setUsage, () => {});
  },
  subagents: (ctx) => say(ctx, formatSubagents(ctx.view, '/subagent <number> for details')),
  subagent: (ctx, args) => {
    const all = subagentList(ctx.view);
    const pick =
      args[0] && /^\d+$/.test(args[0])
        ? all[Number(args[0]) - 1]
        : all.find((x) => x.id === args[0]);
    const child = pick && childView(ctx.view, pick.id);
    say(
      ctx,
      child && pick
        ? `── ${pick.row.agent}: ${pick.row.task} ──\n${describeSession(child)}`
        : 'usage: /subagent <number from /subagents>',
    );
  },
  mcp: async (ctx) => {
    const { servers } = await ctx.client.request('mcp.list', {});
    say(ctx, `MCP servers\n${formatMcpServers(servers)}`);
  },
  worktrees: async (ctx, args) => {
    if (!args[0]) return say(ctx, formatWorktrees(await ctx.client.request('worktrees.list', {})));
    say(ctx, formatWorktreeDiff(await ctx.client.request('worktrees.diff', { branch: args[0] })));
  },
  copy,
  rewind: (ctx) => ctx.openRewind(),
  shells: async (ctx, args) => {
    if (args[0] === 'kill') {
      if (!args[1]) return say(ctx, 'usage: /shells kill <id>');
      const shell = await ctx.client
        .request('shells.kill', { shellId: args[1] })
        .catch((err: Error) => say(ctx, `shells: ${err.message}`));
      if (shell)
        say(ctx, `${shell.id} ${shell.status === 'killed' ? 'stopped' : 'had already exited'}`);
      return;
    }
    say(ctx, formatShells(await ctx.client.request('shells.list', {})));
  },
  mode: async (ctx, args) => {
    const { modes, mode } = await ctx.client.request('permissions.list', {
      sessionId: ctx.session.id,
    });
    if (!args[0])
      return say(
        ctx,
        [
          ...modes.map(
            (m) => `${m === mode ? '●' : ' '} ${modeLabel(m).padEnd(18)} ${MODE_DESCRIPTIONS[m]}`,
          ),
          '/mode <name> to switch; Shift+Tab cycles',
        ].join('\n'),
      );
    const next = parseMode(args[0]);
    if (!next) return say(ctx, 'usage: /mode default|accept-edits|plan|bypass');
    try {
      await ctx.client.request('session.setMode', { sessionId: ctx.session.id, mode: next });
      say(ctx, `mode: ${modeLabel(next)}. ${MODE_DESCRIPTIONS[next]}`);
    } catch (err) {
      say(ctx, `mode: ${(err as Error).message}`);
    }
  },
  permissions: async (ctx) => {
    const p = await ctx.client.request('permissions.list', { sessionId: ctx.session.id });
    say(ctx, formatPermissions(p));
  },
  receipt: async (ctx) => {
    const u = await ctx.client.request('usage.get', { sessionId: ctx.session.id });
    say(ctx, formatReceipt(u, 'This session, including subagents'));
  },
  compact: async (ctx) => {
    const { compacted } = await ctx.client
      .request('session.compact', { sessionId: ctx.session.id })
      .catch((err: Error) => {
        say(ctx, `compact: ${err.message}`);
        return { compacted: true };
      });
    if (!compacted) say(ctx, 'Nothing to compact yet.');
  },
  help: (ctx) => say(ctx, helpText(ctx.custom)),
  theme: (ctx, args) => {
    const name = args[0]?.toLowerCase();
    if (!name)
      return say(
        ctx,
        `${THEME_NAMES.map((n) => `${n === ctx.theme ? '●' : ' '} ${n}`).join('\n')}\n/theme <name> to switch`,
      );
    if (!THEME_NAMES.includes(name as ThemeName))
      return say(ctx, `usage: /theme ${THEME_NAMES.join('|')}`);
    ctx.setTheme(name as ThemeName);
    say(ctx, `theme: ${name}`);
  },
  exit: (ctx) => ctx.exit(),
  quit: (ctx) => ctx.exit(),
};

/** Run `/cmd args...`. */
export function runSlashCommand(ctx: SlashContext, text: string): Promise<void> | void {
  const [cmd = '', ...args] = text.slice(1).split(/\s+/);
  const handler = HANDLERS[cmd];
  if (!handler) return say(ctx, `unknown command /${cmd}; try /help`);
  return handler(ctx, args);
}
