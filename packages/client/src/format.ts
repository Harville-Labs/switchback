/**
 * Text for people: labels the view model puts in rows, and the plain-text
 * reports both clients and `switchback` commands print (/usage, /roles, ...).
 */
import type {
  AgentSummary,
  InitializeResult,
  McpServerInfo,
  ModelRef,
  PermissionMode,
  SessionRoles,
  ShellInfo,
} from '@switchback/protocol';
import { EffortLevel } from '@switchback/protocol';
import type { TodoItem, ViewItem, ViewState } from './view.ts';

export function compactedLabel(messages: number, before: number, after: number): string {
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `Compacted ${messages} earlier messages into a summary (~${k(before)} → ~${k(after)} tokens). The full history is kept.`;
}

/** `Redacted 2 secrets (GITHUB_TOKEN ×2) before sending to claude-opus-5`. */
export function redactedLabel(kinds: string[], model: ModelRef): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const list = [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
  return `Redacted ${kinds.length} secret${kinds.length === 1 ? '' : 's'} (${list}) before sending to ${model.model}; the model sees placeholders.`;
}

/**
 * A review row as text, shared by the TUI and `switchback run`: a headline, then
 * one line per finding.
 */
export function reviewLines(r: Extract<ViewItem, { kind: 'review' }>): string[] {
  const who = r.model?.model ?? 'reviewer';
  const head =
    r.verdict === 'approve'
      ? `✓ Reviewed by ${who}: approved${r.summary ? `. ${r.summary}` : ''}`
      : r.verdict === 'revise'
        ? `↻ ${who} asked for changes${r.summary ? `: ${r.summary}` : ''}`
        : `Review skipped: ${r.summary}`;
  return [
    head,
    ...r.issues.map(
      (i) =>
        `  ${i.severity === 'bug' ? '✗' : i.severity === 'risk' ? '!' : '·'} ${i.file}${i.line ? `:${i.line}` : ''} ${i.comment}`,
    ),
  ];
}

/** Shown when a session becomes pinned local. */
export function privateLabel(reason: string): string {
  return `🔒 This session now stays on local models: ${reason} (privacy.localOnlyPaths).`;
}

/** `≈ $0.04`, shared by both clients' escalation prompts; empty when unknown. */
export function estimateLabel(usd: number | undefined): string {
  if (usd === undefined) return '';
  if (usd < 0.01) return '≈ <$0.01';
  return `≈ $${usd.toFixed(2)}`;
}

/** Tools whose rows the transcript leaves out: the checklist panel shows `todo`. */
export function isQuietTool(name: string): boolean {
  return name === 'todo';
}

/** The checklist as lines: `☑ done`, `▶ in progress`, `☐ to do`. */
export function formatTodos(todos: readonly TodoItem[]): string[] {
  const mark = { done: '☑', in_progress: '▶', pending: '☐' } as const;
  return todos.map((t) => `${mark[t.status]} ${t.text}`);
}

/**
 * Model reasoning as readable paragraphs: Markdown emphasis dropped (models
 * mark section titles with `**...**`), runs of blank lines collapsed, and
 * each title set apart from the paragraph before it.
 */
export function formatReasoning(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The last `rows` lines of text wrapped to `width`, for a live preview that
 * stays the same height while it streams instead of sliding along one line.
 */
export function tailLines(text: string, width: number, rows: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = '';
      }
      line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out.slice(-rows);
}

/** The shell command that reopens a saved session. */
export function resumeCommand(sessionId: string): string {
  return `switchback resume ${sessionId}`;
}

/** Printed after leaving the TUI, once the full-screen view is gone, so it stays in the scrollback. */
export function resumeHint(sessionId: string): string {
  return `Resume this session with: ${resumeCommand(sessionId)}`;
}

/** What `session.escalate` means for the user, by when it takes effect. */
export function escalateNotice(when: 'next-step' | 'next-prompt'): string {
  return when === 'next-step'
    ? '↑ Escalating: the next step of this turn goes one step up the ladder.'
    : '↑ Your next prompt starts one step up the ladder.';
}

/** `52 tok/s`, or `1.2k tok/s` for very fast servers. */
export function speedLabel(tokensPerSecond: number): string {
  const n =
    tokensPerSecond >= 1000
      ? `${(tokensPerSecond / 1000).toFixed(1)}k`
      : String(Math.round(tokensPerSecond));
  return `${n} tok/s`;
}

/** How an attached image is listed in a transcript. */
export function imageLabel(name: string): string {
  return `🖼 ${name}`;
}

/** Why a permission prompt asks, when it's more than the usual level: one line, or undefined. */
export function permissionWhy(p: { askRule?: string; reason?: string }): string | undefined {
  if (p.askRule) return `The rule ${p.askRule} asks every time.`;
  if (p.reason) return `Asking because: ${p.reason}.`;
  return undefined;
}

/** Short human label for a tool call, e.g. `read src/app.ts` or `$ bun test`. */
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]) =>
    keys.map((k) => i[k]).find((v) => typeof v === 'string') as string | undefined;
  // Coding agent CLIs (Claude Code) name tools `Bash`, `Edit`, … with `file_path`.
  switch (name === 'Bash' ? 'bash' : name) {
    case 'bash':
      return `$ ${first('command') ?? ''}`;
    case 'task':
      return `${first('agent') ?? 'agent'}: ${first('description') ?? ''}`;
    case 'skill': {
      const file = first('file');
      return `skill ${first('name') ?? ''}${file ? ` · ${file}` : ''}`;
    }
    default: {
      const arg = first('path', 'file_path', 'pattern', 'file', 'url', 'query');
      return arg ? `${name.toLowerCase()} ${arg}` : name.toLowerCase();
    }
  }
}

/** `/agents`: one line per agent with where it runs and how it's tuned. */
export function formatAgents(agents: AgentSummary[]): string {
  return agents
    .map((a) => {
      const tags = [
        a.source,
        a.mode === 'all' ? undefined : a.mode,
        a.route === 'auto' ? undefined : a.route,
        a.model,
        a.effort ? `effort ${a.effort}` : undefined,
      ].filter(Boolean);
      return `${a.name} [${tags.join(', ')}]: ${a.description}`;
    })
    .join('\n');
}

/**
 * An effort as people type it for `/effort`: a level, or `default` (also
 * `auto`, `reset`) for null, which clears the session's choice. Undefined
 * when it's neither.
 */
export function parseEffort(input: string): EffortLevel | null | undefined {
  const key = input.toLowerCase();
  if (key === 'default' || key === 'auto' || key === 'reset') return null;
  const level = EffortLevel.safeParse(key);
  return level.success ? level.data : undefined;
}

/** The effort a session set, from the latest event or else its summary. */
export function sessionEffort(
  view: Pick<ViewState, 'effort'>,
  session: { effort?: string },
): string | undefined {
  return view.effort === undefined ? session.effort : (view.effort ?? undefined);
}

/** What `/effort` says about a session's effort. */
export function effortNotice(effort: string | undefined): string {
  return effort
    ? `effort: ${effort} for this session's model calls; /effort default follows the agent and models again`
    : "effort: following the agent's and each model's setting";
}

/** `switchback mcp`, doctor, and the TUI's `/mcp`. */
export function formatMcpServers(servers: McpServerInfo[]): string {
  if (!servers.length)
    return 'No MCP servers configured. Add them under `mcpServers` (see docs/configuration.md).';
  const LISTED = 8;
  return servers
    .map((s) => {
      const icon = s.state === 'connected' ? '✓' : s.state === 'disabled' ? '-' : '✗';
      const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
      const counts = [
        count(s.tools, 'tool'),
        s.resources?.length ? count(s.resources.length, 'resource') : '',
        s.prompts?.length ? count(s.prompts.length, 'prompt') : '',
      ].filter(Boolean);
      const head = `  ${icon} ${s.name}: ${s.state}${s.state === 'connected' ? `, ${counts.join(', ')}` : ''}${s.error ? ` (${s.error})` : ''}`;
      // What can be typed: `@server:uri` for resources, `/server:prompt` for prompts.
      const more = (n: number) => (n > LISTED ? [`      …and ${n - LISTED} more`] : []);
      const resources = (s.resources ?? [])
        .slice(0, LISTED)
        .map((r) => `      @${s.name}:${r.uri}${r.description ? `  ${r.description}` : ''}`);
      const prompts = (s.prompts ?? []).slice(0, LISTED).map((p) => {
        const args = (p.arguments ?? [])
          .map((a) => (a.required ? ` <${a.name}>` : ` [${a.name}]`))
          .join('');
        return `      /${s.name}:${p.name}${args}${p.description ? `  ${p.description}` : ''}`;
      });
      return [
        head,
        ...resources,
        ...more(s.resources?.length ?? 0),
        ...prompts,
        ...more(s.prompts?.length ?? 0),
      ].join('\n');
    })
    .join('\n');
}

type ModelSummary = InitializeResult['models'][number];

/** One model for people: `large (qwen3-coder-480b, local)`. */
function modelLabel(alias: string, models: ModelSummary[]): string {
  const m = models.find((x) => x.alias === alias);
  return m ? `${alias} (${m.ref.model}, ${m.tier})` : `${alias} (not configured)`;
}

/** Ladder steps on one line: `large → big-remote | sol`; with `models`, each with its model and tier. */
export function formatSteps(steps: string[][], models?: ModelSummary[]): string {
  const name = (a: string) => (models ? modelLabel(a, models) : a);
  return steps.map((step) => step.map(name).join(' | ')).join(' → ');
}

/** Who reviews, in words: `off`, the reviewers in order, or the escalation ladder. */
export function formatReviewers(roles: SessionRoles, models?: ModelSummary[]): string {
  if (roles.review.mode === 'off') return 'off';
  if (roles.review.models.length) return formatSteps(roles.review.models, models);
  return `the escalation ladder${roles.escalate.length ? '' : ' (empty: nobody reviews)'}`;
}

/** The roles a model fills: `current`, `step 2`, `reviews`, `subagents`. */
export function rolesOfModel(alias: string, roles: SessionRoles): string[] {
  return [
    roles.current.includes(alias) ? 'current' : '',
    ...roles.escalate.flatMap((step, i) => (step.includes(alias) ? [`step ${i + 1}`] : [])),
    roles.review.models.some((s) => s.includes(alias)) ? 'reviews' : '',
    roles.subagents === alias ? 'subagents' : '',
  ].filter(Boolean);
}

/**
 * A session's roles for people, marking what the session changed (ADR 0015).
 * Plain labels: "current" and "escalate" are the config's words, not what a
 * newcomer reads them as.
 */
export function formatRoles(roles: SessionRoles, models: ModelSummary[]): string {
  const mark = (k: SessionRoles['overridden'][number]) =>
    roles.overridden.includes(k) ? '  (this session)' : '';
  const [first, ...backups] = roles.current;
  const ladder = roles.escalate.map((step, i) => `${i + 1}. ${formatSteps([step], models)}`);
  return [
    `turns start on    ${first ? formatSteps([[first]], models) : '(none)'}${mark('current')}`,
    ...(backups.length
      ? [
          `  then backups    ${formatSteps(
            backups.map((b) => [b]),
            models,
          )}  (when it's down or a prompt won't fit)`,
        ]
      : []),
    `hard turns go to  ${ladder.length ? ladder.join(', then ') : 'nowhere (they stay where they started)'}${mark('escalate')}`,
    `edits reviewed    ${roles.review.mode === 'off' ? 'never' : `by ${formatReviewers(roles, models)}`}${mark('review')}`,
    `subagents use     ${roles.subagents ? modelLabel(roles.subagents, models) : 'normal routing'}${mark('subagents')}`,
  ].join('\n');
}

/** Where the session is on the escalation ladder, for a status line; empty on the current model. */
export function formatLadder(ladder: ViewState['ladder']): string {
  if (!ladder || ladder.step === 0) return '';
  const sticky = ladder.stickyTurns ? `, ${ladder.stickyTurns} more` : '';
  return `step ${ladder.step}/${ladder.steps} ${ladder.model}${sticky}`;
}

/** Everything configured, with its tier and the roles it fills. */
export function formatModels(models: ModelSummary[], roles?: SessionRoles): string {
  const width = Math.max(0, ...models.map((m) => m.alias.length));
  const rows = models.map((m) => {
    const filled = roles ? rolesOfModel(m.alias, roles) : [];
    const notes = [...filled, ...(m.listed && !filled.length ? ['listed by its endpoint'] : [])];
    return `${m.alias.padEnd(width)}  ${m.ref.model} (${m.tier})${notes.length ? `  · ${notes.join(', ')}` : ''}`;
  });
  return [...rows, MODELS_HINT].join('\n');
}

/** Where to go from a model list: both clients take these commands. */
export const MODELS_HINT =
  '/models refresh asks your endpoints for their models again · /init adds or edits models';

/*
 * Marks in the status bar and the transcript are one terminal cell in every
 * terminal. Emoji-capable symbols (☁ ⚠ ⏸) are not: Windows Terminal and
 * others draw them two cells wide while Ink counts one, so they cover the
 * space after them. These are all in code page 437, so conhost's fonts have
 * them too.
 */
const MODE_ICONS: Record<PermissionMode, string> = {
  default: '',
  acceptEdits: '»',
  autoApprove: '√',
  plan: '║',
  bypassPermissions: '!',
};

/** The mark before a mode's name in the status bar; empty for the default mode. */
export function modeIcon(mode: PermissionMode): string {
  return MODE_ICONS[mode];
}

/** The mark before a model's name: a house for local, an arrow up the ladder for remote. */
export function tierIcon(tier: string | undefined): string {
  return tier === 'local' ? '⌂' : '▲';
}

/** The conversation as Markdown: prompts, replies, and tool calls, for `/copy all`. */
export function transcriptMarkdown(items: readonly ViewItem[]): string {
  const parts: string[] = [];
  for (const it of items) {
    if (it.kind === 'user') parts.push(`## You\n\n${it.text}`);
    else if (it.kind === 'assistant' && it.text) parts.push(it.text);
    else if (it.kind === 'tool')
      parts.push(`> ${toolLabel(it.name, it.input)}${it.status === 'error' ? ' (failed)' : ''}`);
  }
  return parts.join('\n\n');
}

/** `/shells`: background shells, running first. */
export function formatShells(shells: readonly ShellInfo[], now = Date.now()): string {
  if (!shells.length) return 'no background shells (bash with background: true starts one)';
  const order = { running: 0, exited: 1, killed: 2 };
  return [...shells]
    .sort((a, b) => order[a.status] - order[b.status] || b.startedAt - a.startedAt)
    .map((s) => {
      const state =
        s.status === 'running'
          ? `running ${Math.round((now - s.startedAt) / 1000)}s`
          : s.status === 'killed'
            ? 'stopped'
            : `exited ${s.exitCode}`;
      return `  ${s.status === 'running' ? '●' : '○'} ${s.id}  ${state.padEnd(14)} $ ${s.command}`;
    })
    .join('\n');
}

/** How many of a view's background shells are running. */
export function runningShells(shells: Record<string, ShellInfo> | undefined): number {
  return Object.values(shells ?? {}).filter((s) => s.status === 'running').length;
}
