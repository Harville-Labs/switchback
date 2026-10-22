/**
 * The TUI's slash commands. The catalog (names, arguments, help) is shared
 * with VS Code through `SLASH_COMMANDS`; this is how the TUI runs each one.
 */
import {
  addInfo,
  autoCompactLabel,
  type ChosenRole,
  childView,
  currentChange,
  dashboardRows,
  describeSession,
  effortNotice,
  escalateNotice,
  formatAgents,
  formatCommands,
  formatDashboard,
  formatMcpServers,
  formatModels,
  formatModes,
  formatPermissions,
  formatReceipt,
  formatRefresh,
  formatRoles,
  formatShells,
  formatSubagents,
  formatUsage,
  formatWorktreeDiff,
  formatWorktrees,
  type Ladder,
  MODE_DESCRIPTIONS,
  modeLabel,
  nextModel,
  parseAutoCompact,
  parseEffort,
  parseMode,
  pickCopy,
  runGoalCommand,
  runReload,
  type SlashCommand,
  subagentList,
  tabAt,
} from '@switchback/client';
import type { RoutePreference, SessionRoles, SessionSetRolesParams } from '@switchback/protocol';
import { copyText } from './clipboard.ts';
import { saveMouse } from './mouse.ts';
import {
  agentChoices,
  effortChoices,
  REVIEW_CHOICES,
  subagentChoices,
  themeChoices,
} from './slash-choices.ts';
import { THEME_NAMES, type ThemeName } from './theme.ts';

const helpText = (custom: readonly SlashCommand[]) => `Commands
${formatCommands('tui', custom)}
Role commands take --save to make the change your default.
Input: @ mentions a file (its contents are attached); paste freely: big pastes
       become a chip, dragged-in files become @ mentions; ↑/↓ browse history;
       option/alt+enter, ctrl+j, or a trailing \\ adds a newline.
Tabs: ctrl+t shows every session (open tabs, and ones working in other windows);
      ctrl+tab / ctrl+shift+tab, alt+←/→, alt+1…9, or a click switch tabs;
      ctrl+w on an empty prompt closes one (it keeps running); /tab new opens one.
      alt+↓ shows each subagent in turn, alt+↑ the session again; /model there
      picks the subagent model.
Keys: during a turn, enter queues a message and esc sends it now (interrupting);
      esc on an empty prompt sends what's queued now, or cancels when nothing is;
      ctrl+c cancels the turn and the queue; ↑ takes back the last queued message;
      shift+tab cycles the permission mode; ctrl+o expands thinking, output, and diffs;
      tab switches to the next model you chose, going round them (in a slash
      command, tab completes the command and its argument instead);
      a command run without the argument it needs lists what it takes to pick from;
      PgUp/PgDn or the mouse wheel scroll (hold shift or option to select text);
      prompts: ↑↓ and enter, or the option's number (y/a/p/n still work).
Your own commands are Markdown files in .switchback/commands/ or
~/.switchback/commands/.`;

import { type Handler, type SlashContext, say } from './slash-context.ts';
import { listSessions, newSession, rename, resume } from './slash-sessions.ts';

export type { SlashContext } from './slash-context.ts';
export { newSession, resume, rewind } from './slash-sessions.ts';

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

/** Tab: the next model the user chose becomes the current one, for this session. */
export async function cycleModel(
  ctx: SlashContext,
  roles: SessionRoles | undefined,
): Promise<void> {
  const next = nextModel(ctx.init.models, roles);
  if (!next)
    return say(
      ctx,
      'No other chosen model to switch to. /current picks from every model, listed ones too; `switchback init` sets more up.',
    );
  try {
    const r = await ctx.client.request('session.setRoles', {
      sessionId: ctx.session.id,
      ...next.change,
    });
    ctx.setView((v) => addInfo({ ...v, roles: r }, `Switched to ${next.alias}.`));
  } catch (err) {
    say(ctx, `switch model: ${(err as Error).message}`);
  }
}

/** `/up`: a stronger model takes over (`session.escalate`). */
async function escalateNow(ctx: SlashContext): Promise<void> {
  try {
    const { when } = await ctx.client.request('session.escalate', { sessionId: ctx.session.id });
    say(ctx, escalateNotice(when));
  } catch (err) {
    say(ctx, `escalate: ${(err as Error).message}`);
  }
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
  if (!args[0]) return ctx.openChoices(REVIEW_CHOICES);
  const next = args[0] === 'on' ? true : args[0] === 'off' ? false : undefined;
  if (args[0] !== 'default' && next === undefined)
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

/** `/current`: pick the current model from a list, or name it (more models are backups). */
function current(ctx: SlashContext, args: string[]): Promise<void> | void {
  const models = rest(args);
  if (!models.length) return ctx.openModelPicker('current');
  return changeRoles(ctx, { current: models, save: saving(args) }, `Current model: ${models[0]}.`);
}

/** `/ladder`: edit the escalation ladder, or set it from steps (`a,b` are alternatives). */
function ladder(ctx: SlashContext, args: string[]): Promise<void> | void {
  const steps = rest(args);
  if (!steps.length) return ctx.openModelPicker('escalate');
  const escalate = steps[0] === 'none' ? [] : steps.map((step) => step.split(','));
  return setLadder(ctx, escalate, saving(args));
}

export function setLadder(ctx: SlashContext, escalate: Ladder, save: boolean): Promise<void> {
  const text = escalate.length
    ? 'New escalation ladder.'
    : 'No escalation ladder: hard turns stay on the model they started on.';
  return changeRoles(ctx, { escalate, save }, text);
}

/** `/subagent-model`: the model subagents start on. */
function subagentModel(ctx: SlashContext, args: string[]): Promise<void> | void {
  const [model] = rest(args);
  if (!model) return ctx.openModelPicker('subagents');
  return changeRoles(
    ctx,
    { subagents: model === 'none' ? null : model, save: saving(args) },
    'Subagent model changed. Subagents started from now on use it.',
  );
}

/** `/model`: the model for what's in front, the session's or (viewing one) its subagents'. */
function model(ctx: SlashContext, args: string[]): Promise<void> | void {
  if (!ctx.focusedSubagent) return current(ctx, args);
  if (!rest(args).length) return ctx.openModelPicker('subagents');
  return subagentModel(ctx, args);
}

/**
 * The model picked in the `/current` or `/model` picker takes the role. A new
 * current model keeps the previous ones as backups.
 */
export function pickModel(
  ctx: SlashContext,
  roles: SessionRoles | undefined,
  role: ChosenRole,
  alias: string,
): Promise<void> {
  return role === 'current'
    ? changeRoles(ctx, currentChange(roles, alias), `Current model: ${alias}.`)
    : changeRoles(
        ctx,
        { subagents: alias },
        `Subagent model: ${alias}. Subagents started from now on use it.`,
      );
}

/** `/tab`: switch to tab n, open a new one, or close the one in front. */
function tab(ctx: SlashContext, args: string[]): Promise<void> | void {
  const [what = '', agent] = args;
  if (!what) return ctx.openDashboard();
  if (what === 'new') return ctx.newTab(agent);
  if (what === 'close') {
    if (ctx.tabs.tabs.length === 1) return say(ctx, 'this is the only tab; /new starts over in it');
    return ctx.closeTab(ctx.session.id);
  }
  const n = Number(what);
  const target = Number.isInteger(n) ? tabAt(ctx.tabs, n) : undefined;
  if (target) return ctx.showSession(target.session.id);
  say(ctx, `${formatDashboard(dashboardRows(ctx.tabs))}\nusage: /tab <n> | new [agent] | close`);
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
  models: async (ctx, args) => {
    if (args[0] === 'refresh') {
      say(ctx, 'Asking endpoints and subscriptions for their models...');
      return say(ctx, formatRefresh(await ctx.client.request('models.refresh', {})));
    }
    const roles = await ctx.client.request('session.roles', { sessionId: ctx.session.id });
    ctx.setView((v) => addInfo({ ...v, roles }, formatModels(ctx.init.models, roles)));
  },
  roles: async (ctx, args) => {
    if (args[0] === 'reset')
      return changeRoles(ctx, { reset: true }, 'Roles follow your config again.');
    const roles = await ctx.client.request('session.roles', { sessionId: ctx.session.id });
    ctx.setView((v) => addInfo({ ...v, roles }, formatRoles(roles, ctx.init.models)));
  },
  current,
  // The command's name before the role was called current.
  start: current,
  ladder,
  // The command's name before it was /ladder.
  escalate: ladder,
  autocompact: async (ctx, args) => {
    const change = parseAutoCompact(args);
    if (!change) return say(ctx, 'usage: /autocompact [on|off] [--save]');
    const sessionId = ctx.session.id;
    const status = await ctx.client.request('session.setAutoCompact', { sessionId, ...change });
    say(ctx, autoCompactLabel(status));
  },
  'subagent-model': subagentModel,
  model,
  review,
  agent: async (ctx, args) =>
    args[0] ? newSession(ctx, args[0]) : ctx.openChoices(await agentChoices(ctx)),
  agents: async (ctx) => {
    // Asked each time, so agents created meanwhile (switchback agents new) show up.
    const agents = await ctx.client.request('agents.list', {}).catch(() => ctx.init.agents);
    say(ctx, formatAgents(agents));
  },
  new: (ctx) => newSession(ctx),
  tabs: (ctx) => ctx.openDashboard(),
  tab,
  sessions: listSessions,
  resume: (ctx, args) => resume(ctx, args[0]),
  rename: (ctx, args) => rename(ctx, args.join(' ')),
  usage: async (ctx, args) => {
    // `/usage` is the weekly picture: where the money went and why.
    const u = await ctx.client.request('usage.get', { period: 'week' });
    const by = (['rule', 'agent', 'model'] as const).find((b) => b === args[0]) ?? 'rule';
    say(ctx, formatUsage(u, by));
    ctx.client.request('usage.get', {}).then(ctx.setUsage, () => {});
  },
  subagents: (ctx) => say(ctx, formatSubagents(ctx.view, '/subagent <number> for details')),
  subagent: (ctx, args) => {
    if (!args[0]) {
      const list = subagentChoices(ctx);
      return list && ctx.openChoices(list);
    }
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
  reload: async (ctx) => say(ctx, await runReload(ctx.client)),
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
    if (!args[0]) return say(ctx, formatModes(modes, mode));
    const next = parseMode(args[0]);
    if (!next) return say(ctx, 'usage: /mode default|accept-edits|auto-approve|plan|bypass');
    try {
      await ctx.client.request('session.setMode', { sessionId: ctx.session.id, mode: next });
      say(ctx, `mode: ${modeLabel(next)}. ${MODE_DESCRIPTIONS[next]}`);
    } catch (err) {
      say(ctx, `mode: ${(err as Error).message}`);
    }
  },
  effort: async (ctx, args) => {
    if (!args[0]) return ctx.openChoices(effortChoices(ctx));
    const effort = parseEffort(args[0]);
    if (effort === undefined)
      return say(ctx, 'usage: /effort none|low|medium|high|xhigh|max|default');
    const set = await ctx.client.request('session.setEffort', {
      sessionId: ctx.session.id,
      effort,
    });
    say(ctx, effortNotice(set.effort));
  },
  goal: async (ctx, args) => {
    const text = await runGoalCommand(ctx.client, ctx.session, ctx.view, args);
    if (text) say(ctx, text);
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
    if (!name) return ctx.openChoices(themeChoices(ctx));
    if (!THEME_NAMES.includes(name as ThemeName))
      return say(ctx, `usage: /theme ${THEME_NAMES.join('|')}`);
    ctx.setTheme(name as ThemeName);
    say(ctx, `theme: ${name}`);
  },
  mouse: (ctx, args) => {
    if (!ctx.mouse) return say(ctx, 'mouse: this terminal UI does not read the mouse');
    const arg = args[0]?.toLowerCase();
    if (arg && arg !== 'on' && arg !== 'off') return say(ctx, 'usage: /mouse [on|off]');
    const on = arg ? arg === 'on' : !ctx.mouse.reporting;
    ctx.mouse.setReporting(on);
    saveMouse(on);
    say(ctx, mouseNotice(on));
  },
  init: (ctx) => ctx.openSetup(),
  setup: (ctx) => ctx.openSetup(),
  exit: (ctx) => ctx.exit(),
  quit: (ctx) => ctx.exit(),
};

function mouseNotice(on: boolean): string {
  return on
    ? 'mouse: on. The wheel scrolls and clicks pick tabs; hold Shift (Option on macOS) while dragging to select text.'
    : 'mouse: off. Drag to select text as usual; Page Up and Page Down scroll.';
}

/** Run `/cmd args...`. */
export function runSlashCommand(ctx: SlashContext, text: string): Promise<void> | void {
  const [cmd = '', ...args] = text.slice(1).split(/\s+/);
  const handler = HANDLERS[cmd];
  if (!handler) return say(ctx, `unknown command /${cmd}; try /help`);
  return handler(ctx, args);
}
