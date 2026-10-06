/**
 * Text for people: labels the view model puts in rows, and the plain-text
 * reports both clients and `switchback` commands print (/usage, /roles, ...).
 */
import type {
  InitializeResult,
  McpServerInfo,
  ModelRef,
  PermissionMode,
  PermissionsListResult,
  SessionRoles,
  ShellInfo,
  UsageReport,
} from '@switchback/protocol';
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

/** Short human label for a tool call, e.g. `read src/app.ts` or `$ bun test`. */
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]) =>
    keys.map((k) => i[k]).find((v) => typeof v === 'string') as string | undefined;
  switch (name) {
    case 'bash':
      return `$ ${first('command') ?? ''}`;
    case 'task':
      return `${first('agent') ?? 'agent'}: ${first('description') ?? ''}`;
    case 'skill': {
      const file = first('file');
      return `skill ${first('name') ?? ''}${file ? ` · ${file}` : ''}`;
    }
    default: {
      const arg = first('path', 'pattern', 'file', 'url', 'query');
      return arg ? `${name} ${arg}` : name;
    }
  }
}

export type UsageBreakdown = 'rule' | 'agent' | 'model';

/**
 * Plain-text usage summary shared by `switchback usage`, the TUI's `/usage`, and
 * VS Code. `by` adds a breakdown table.
 */
export function formatUsage(u: UsageReport, by?: UsageBreakdown): string {
  const $ = (n: number) => `$${n.toFixed(2)}`;
  const tok = (n: number) => n.toLocaleString('en-US');
  const { local, remote } = u.byTier;
  const lines = [
    `Usage ${u.period.from} to ${u.period.to}`,
    `  local   ${tok(local.usage.inputTokens)} in / ${tok(local.usage.outputTokens)} out   ${$(0)}`,
    `  remote  ${tok(remote.usage.inputTokens)} in / ${tok(remote.usage.outputTokens)} out   ${$(remote.costUsd)}${u.remoteCacheHitRate !== undefined ? `   cache hits ${Math.round(u.remoteCacheHitRate * 100)}%` : ''}`,
    `  saved   ~${$(u.estimatedSavingsUsd)} vs. running everything remotely`,
    `  budget  today ${$(u.budget.spentTodayUsd)}${u.budget.dailyUsd ? ` of ${$(u.budget.dailyUsd)}` : ''}, month ${$(u.budget.spentMonthUsd)}${u.budget.monthlyUsd ? ` of ${$(u.budget.monthlyUsd)}` : ''}`,
  ];
  const rows = by === 'rule' ? u.byRule : by === 'agent' ? u.byAgent : by ? u.byModel : undefined;
  if (by && rows) {
    lines.push('', `By ${by}`);
    const width = Math.max(by.length, ...rows.map((r) => r.key.length));
    for (const r of rows) {
      lines.push(
        `  ${r.key.padEnd(width)}  ${String(r.calls).padStart(5)} calls  ${tok(r.usage.inputTokens + (r.usage.cacheReadTokens ?? 0)).padStart(12)} in  ${$(r.costUsd).padStart(9)}`,
      );
    }
    if (rows.length === 0) lines.push('  no model calls in this period');
  }
  return lines.join('\n');
}

/**
 * The savings receipt: what a session (with its subagents) cost, against what
 * the same work would have cost on the reference remote model.
 */
export function formatReceipt(u: UsageReport, title = 'This session'): string {
  const $ = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
  const tok = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${Math.round(n / 1000)}k`
        : String(n);
  const { local, remote } = u.byTier;
  const localTokens = local.usage.inputTokens + (local.usage.cacheReadTokens ?? 0);
  const remoteTokens = remote.usage.inputTokens + (remote.usage.cacheReadTokens ?? 0);
  const allRemote = remote.costUsd + u.estimatedSavingsUsd;
  const lines = [
    title,
    `  local    ${$(0).padStart(7)}   ${tok(localTokens)} tokens in, ${tok(local.usage.outputTokens)} out`,
    `  remote   ${$(remote.costUsd).padStart(7)}   ${tok(remoteTokens)} tokens in, ${tok(remote.usage.outputTokens)} out`,
  ];
  if (u.referenceModel && u.estimatedSavingsUsd > 0) {
    const pct = allRemote > 0 ? Math.round((u.estimatedSavingsUsd / allRemote) * 100) : 0;
    lines.push(
      `  all-remote on ${u.referenceModel} would have cost ~${$(allRemote)}`,
      `  saved    ~${$(u.estimatedSavingsUsd)} (${pct}%)`,
    );
  } else if (!u.referenceModel && localTokens > 0) {
    lines.push('  (configure a remote model to see what running locally saved)');
  }
  return lines.join('\n');
}

/** One line for the end of a headless run: `cost $0.04 · saved ~$0.61 (94%) vs. claude-opus-5`. */
export function receiptLine(u: UsageReport): string {
  const cost = u.byTier.remote.costUsd;
  const allRemote = cost + u.estimatedSavingsUsd;
  const saved =
    u.referenceModel && u.estimatedSavingsUsd > 0
      ? ` · saved ~$${u.estimatedSavingsUsd.toFixed(2)} (${Math.round((u.estimatedSavingsUsd / allRemote) * 100)}%) vs. all-remote on ${u.referenceModel}`
      : '';
  return `cost $${cost.toFixed(4)}${saved}`;
}

/** Every subagent in the tree, depth-first, for numbered listings. */
export function subagentList(
  state: ViewState,
  depth = 0,
): { id: string; depth: number; row: Extract<ViewItem, { kind: 'subagent' }> }[] {
  return state.items.flatMap((it) =>
    it.kind === 'subagent'
      ? [
          { id: it.id, depth, row: it },
          ...(state.children[it.id]
            ? subagentList(state.children[it.id] as ViewState, depth + 1)
            : []),
        ]
      : [],
  );
}

/** The subagent tree as numbered lines, for `/subagents`; `hint` follows a non-empty list. */
export function formatSubagents(state: ViewState, hint = ''): string {
  const all = subagentList(state);
  if (!all.length) return 'no subagents in this session yet';
  const rows = all.map(
    (x, i) =>
      `${String(i + 1).padStart(2)}. ${'  '.repeat(x.depth)}${x.row.status === 'running' ? '◌' : x.row.status === 'ok' ? '✓' : '✗'} ${x.row.agent}: ${x.row.task} · ${x.row.toolCalls} tool calls`,
  );
  return [...rows, ...(hint ? [hint] : [])].join('\n');
}

/**
 * Plain-text drill-down of one session: its routes, tool calls, and report,
 * with nested subagents indented. Used by the TUI's `/subagent`.
 */
export function describeSession(state: ViewState, indent = ''): string {
  const lines: string[] = [];
  for (const it of state.items) {
    switch (it.kind) {
      case 'user':
        lines.push(`${indent}task: ${it.text}`);
        break;
      case 'route':
        lines.push(`${indent}${it.tier === 'local' ? '⌂' : '☁'} ${it.model.model} · ${it.reason}`);
        break;
      case 'tool': {
        // A delegation is shown by its subagent row below.
        if (it.name === 'task' && it.status !== 'error') break;
        const icon = it.status === 'running' ? '●' : it.status === 'ok' ? '✓' : '✗';
        lines.push(`${indent}${icon} ${toolLabel(it.name, it.input)}`);
        const first = it.output?.split('\n').find((l) => l.trim());
        if (first) lines.push(`${indent}    ${first.slice(0, 160)}`);
        break;
      }
      case 'assistant':
        if (it.text) lines.push(...it.text.split('\n').map((l) => `${indent}${l}`));
        break;
      case 'subagent': {
        const icon = it.status === 'running' ? '◌' : it.status === 'ok' ? '✓' : '✗';
        lines.push(`${indent}↳ ${icon} ${it.agent}: ${it.task}`);
        const child = state.children[it.id];
        if (child) lines.push(describeSession(child, `${indent}    `));
        break;
      }
      case 'error':
        lines.push(`${indent}error: ${it.message}`);
        break;
      case 'info':
        break;
    }
  }
  return lines.join('\n');
}

/** `switchback mcp`, doctor, and the TUI's `/mcp`. */
export function formatMcpServers(servers: McpServerInfo[]): string {
  if (!servers.length)
    return 'No MCP servers configured. Add them under `mcpServers` (see docs/configuration.md).';
  return servers
    .map((s) => {
      const icon = s.state === 'connected' ? '✓' : s.state === 'disabled' ? '-' : '✗';
      return `  ${icon} ${s.name}: ${s.state}${s.state === 'connected' ? `, ${s.tools} tools` : ''}${s.error ? ` (${s.error})` : ''}`;
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

/** The roles a model fills: `start`, `step 2`, `reviews`, `subagents`. */
export function rolesOfModel(alias: string, roles: SessionRoles): string[] {
  return [
    roles.start.includes(alias) ? 'start' : '',
    ...roles.escalate.flatMap((step, i) => (step.includes(alias) ? [`step ${i + 1}`] : [])),
    roles.review.models.some((s) => s.includes(alias)) ? 'reviews' : '',
    roles.subagents === alias ? 'subagents' : '',
  ].filter(Boolean);
}

/** A session's roles for people, marking what the session changed (ADR 0015). */
export function formatRoles(roles: SessionRoles, models: ModelSummary[]): string {
  const mark = (k: SessionRoles['overridden'][number]) =>
    roles.overridden.includes(k) ? '  (this session)' : '';
  return [
    `start      ${formatSteps([roles.start], models) || '(none)'}${mark('start')}`,
    `escalate   ${formatSteps(roles.escalate, models) || '(nothing)'}${mark('escalate')}`,
    `review     ${formatReviewers(roles, models)}${mark('review')}`,
    `subagents  ${roles.subagents ? modelLabel(roles.subagents, models) : 'normal routing'}${mark('subagents')}`,
  ].join('\n');
}

/** Where the session is on the escalation ladder, for a status line; empty at the start model. */
export function formatLadder(ladder: ViewState['ladder']): string {
  if (!ladder || ladder.step === 0) return '';
  const sticky = ladder.stickyTurns ? `, ${ladder.stickyTurns} more` : '';
  return `step ${ladder.step}/${ladder.steps} ${ladder.model}${sticky}`;
}

/** Everything configured, with its tier and the roles it fills. */
export function formatModels(models: ModelSummary[], roles?: SessionRoles): string {
  return models
    .map((m) => {
      const filled = roles ? rolesOfModel(m.alias, roles) : [];
      return `${m.alias}  ${m.ref.model} (${m.tier})${filled.length ? `  · ${filled.join(', ')}` : ''}`;
    })
    .join('\n');
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  plan: 'plan',
  bypassPermissions: 'bypass permissions',
};

/** What each mode does, for pickers and `/mode`. */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'ask before edits and commands, as the permission levels say',
  acceptEdits: 'edits in the workspace go ahead; commands still ask',
  plan: 'read and plan only; nothing changes until you approve the plan',
  bypassPermissions: 'everything goes ahead except what deny and ask rules stop',
};

export function modeLabel(mode: PermissionMode): string {
  return MODE_LABELS[mode];
}

/** A mode as people type it: `plan`, `accept-edits`, `bypass`, or the config name. */
export function parseMode(input: string): PermissionMode | undefined {
  const key = input.toLowerCase().replace(/[-_\s]/g, '');
  const aliases: Record<string, PermissionMode> = {
    default: 'default',
    normal: 'default',
    acceptedits: 'acceptEdits',
    accept: 'acceptEdits',
    plan: 'plan',
    bypass: 'bypassPermissions',
    bypasspermissions: 'bypassPermissions',
  };
  return aliases[key];
}

/** The mode after `current` when cycling (Shift+Tab), among those allowed. */
export function nextMode(current: PermissionMode, allowed: PermissionMode[]): PermissionMode {
  const i = allowed.indexOf(current);
  return allowed[(i + 1) % allowed.length] ?? 'default';
}

/** `/permissions`: the mode, the levels, and every rule with where it came from. */
export function formatPermissions(p: PermissionsListResult): string {
  const lines = [
    ...(p.mode ? [`mode   ${modeLabel(p.mode)}: ${MODE_DESCRIPTIONS[p.mode]}`] : []),
    `levels read ${p.levels.read} · edit ${p.levels.edit} · bash ${p.levels.bash} · web ${p.levels.web} · mcp ${p.levels.mcp}`,
    `sandbox ${p.sandbox.active ? 'on: bash commands run in the OS sandbox' : `off: ${p.sandbox.reason}`}`,
  ];
  if (!p.rules.length) lines.push('rules  none (see docs/permissions.md)');
  else {
    const width = Math.max(...p.rules.map((r) => r.rule.length));
    lines.push('rules');
    for (const r of p.rules)
      lines.push(`  ${r.behavior.padEnd(5)} ${r.rule.padEnd(width)}  ${r.source}`);
  }
  return lines.join('\n');
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
