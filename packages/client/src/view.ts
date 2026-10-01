/**
 * Shared view model. Folds engine events into what a UI should display. The
 * TUI and the VS Code webview both render from this reducer, so they cannot
 * disagree about what happened in a session.
 */
import type {
  EngineEvent,
  McpServerInfo,
  Message,
  ModelRef,
  PermissionDecision,
  ReviewIssue,
  SessionSummary,
  Tier,
  UsageReport,
} from '@switchback/protocol';

export type ViewItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; reasoning: string }
  | { kind: 'route'; id: string; tier: Tier; model: ModelRef; rule: string; reason: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      output?: string;
      /** The result carried private content (`privacy.localOnlyPaths`). */
      private?: string;
    }
  | {
      kind: 'subagent';
      id: string;
      agent: string;
      task: string;
      status: 'running' | 'ok' | 'error';
      tier?: Tier;
      activity?: string;
      toolCalls: number;
      /** The parent didn't wait; the report arrives later as a message. */
      background?: boolean;
    }
  | {
      kind: 'review';
      id: string;
      verdict: 'approve' | 'revise' | 'skipped';
      summary: string;
      issues: ReviewIssue[];
      model?: ModelRef;
      round: number;
    }
  | { kind: 'error'; id: string; message: string }
  /** Client-local notices (slash command output); never produced by the engine. */
  | { kind: 'info'; id: string; text: string };

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  /** Unified diff for edits. */
  preview?: string;
}

export interface PendingEscalation {
  requestId: string;
  reason: string;
  target: ModelRef;
  estimatedCostUsd?: number;
}

function compactedLabel(messages: number, before: number, after: number): string {
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

export interface ViewState {
  sessionId: string;
  items: ViewItem[];
  running: boolean;
  permissions: PendingPermission[];
  escalations: PendingEscalation[];
  costUsd: number;
  /** Saved versus running this session all-remote (this session only, not its subagents). */
  savingsUsd: number;
  lastTier?: Tier;
  /** Why the session is pinned local for privacy; set once and never cleared. */
  private?: string;
  /** Each subagent's own view, keyed by child session ID (nested for deeper subagents). */
  children: Record<string, ViewState>;
}

export function initialView(sessionId: string): ViewState {
  return {
    sessionId,
    items: [],
    running: false,
    permissions: [],
    escalations: [],
    costUsd: 0,
    savingsUsd: 0,
    children: {},
  };
}

/** Whether `sessionId` is this session or any of its descendants. */
function owns(state: ViewState, sessionId: string): boolean {
  if (state.sessionId === sessionId) return true;
  return Object.values(state.children).some((c) => owns(c, sessionId));
}

/** The agent name of a descendant session, from its parent's subagent row. */
export function agentOf(state: ViewState, sessionId: string): string | undefined {
  for (const it of state.items) if (it.kind === 'subagent' && it.id === sessionId) return it.agent;
  for (const c of Object.values(state.children)) {
    const found = agentOf(c, sessionId);
    if (found) return found;
  }
  return undefined;
}

/** A descendant's view (drill-down), or undefined if it isn't part of this tree. */
export function childView(state: ViewState, sessionId: string): ViewState | undefined {
  if (state.sessionId === sessionId) return state;
  for (const c of Object.values(state.children)) {
    const found = childView(c, sessionId);
    if (found) return found;
  }
  return undefined;
}

/**
 * Rebuild a view from a stored transcript, for resuming a session. Routing
 * rows use the rule `history`; reasoning is not replayed into the view.
 */
export function fromTranscript(session: SessionSummary, messages: Message[]): ViewState {
  const items: ViewItem[] = [];
  const tools = new Map<string, Extract<ViewItem, { kind: 'tool' }>>();
  messages.forEach((m, mi) => {
    if (m.role === 'user') {
      for (const p of m.parts) {
        if (p.type === 'text' && p.backgroundTask)
          items.push({
            kind: 'info',
            id: `h${mi}b${p.backgroundTask.sessionId}`,
            text: `↳ background ${p.backgroundTask.agent} ${p.backgroundTask.ok ? 'finished' : 'failed'}; its report went to the agent`,
          });
        else if (p.type === 'text' && p.review)
          items.push({
            kind: 'info',
            id: `h${mi}v`,
            text: `↻ ${p.review.model.model}'s review findings went back to the model (round ${p.review.round})`,
          });
        else if (p.type === 'text' && p.attachment)
          items.push({
            kind: 'info',
            id: `h${mi}f${p.attachment.path}`,
            text: `📎 ${p.attachment.path}`,
          });
        else if (p.type === 'text') items.push({ kind: 'user', id: `h${mi}u`, text: p.text });
        else if (p.type === 'compaction')
          items.push({
            kind: 'info',
            id: `h${mi}c`,
            text: compactedLabel(p.keepFrom, p.tokensBefore, p.tokensAfter),
          });
        else if (p.type === 'tool_result') {
          const t = tools.get(p.callId);
          if (t) {
            t.status = p.isError ? 'error' : 'ok';
            t.output = p.content;
            if (p.private) t.private = p.private;
          }
        }
      }
      return;
    }
    if (m.meta) {
      items.push({
        kind: 'route',
        id: `h${mi}r`,
        tier: m.meta.tier,
        model: m.meta.model,
        rule: 'history',
        reason: m.meta.routeReason ?? '',
      });
    }
    m.parts.forEach((p, pi) => {
      if (p.type === 'text' && p.text)
        items.push({ kind: 'assistant', id: `h${mi}a${pi}`, text: p.text, reasoning: '' });
      else if (p.type === 'tool_call') {
        const t = {
          kind: 'tool' as const,
          id: p.id,
          name: p.name,
          input: p.input,
          status: 'error' as 'running' | 'ok' | 'error',
        };
        tools.set(p.id, t);
        items.push(t);
      }
    });
  });
  const lastRoute = items.findLast((i) => i.kind === 'route');
  const priv = messages
    .flatMap((m) => m.parts)
    .find((p) => (p.type === 'text' || p.type === 'tool_result') && p.private);
  return {
    ...initialView(session.id),
    items,
    ...(priv && 'private' in priv && priv.private ? { private: priv.private } : {}),
    // Joining a session mid-turn: the live events that follow will finish it.
    running: !!session.running,
    costUsd: session.costUsd,
    savingsUsd: session.savingsUsd ?? 0,
    ...(lastRoute?.kind === 'route' ? { lastTier: lastRoute.tier } : {}),
  };
}

export function addInfo(state: ViewState, text: string): ViewState {
  return {
    ...state,
    items: [...state.items, { kind: 'info', id: `i${state.items.length}`, text }],
  };
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
    default: {
      const arg = first('path', 'pattern', 'file');
      return arg ? `${name} ${arg}` : name;
    }
  }
}

/** Record a prompt the user just sent (the engine does not echo it). */
export function addUserPrompt(state: ViewState, text: string): ViewState {
  return {
    ...state,
    running: true,
    items: [...state.items, { kind: 'user', id: `u${state.items.length}`, text }],
  };
}

export function resolvePermission(
  state: ViewState,
  requestId: string,
  _d: PermissionDecision,
): ViewState {
  return { ...state, permissions: state.permissions.filter((p) => p.requestId !== requestId) };
}

export function resolveEscalation(state: ViewState, requestId: string): ViewState {
  return { ...state, escalations: state.escalations.filter((p) => p.requestId !== requestId) };
}

export function reduce(state: ViewState, event: EngineEvent): ViewState {
  if (event.type === 'log') return state;
  if (event.type === 'config.updated') {
    const head = event.org
      ? `${event.org.name} policy updated (revision ${event.org.version})`
      : 'configuration updated';
    return addInfo(state, [head, ...event.notes.map((n) => `  ${n}`)].join('\n'));
  }

  if (event.type === 'permission.resolved')
    return resolvePermission(state, event.requestId, event.decision);
  if (event.type === 'escalation.resolved') return resolveEscalation(state, event.requestId);

  // Permission prompts can come from any descendant session.
  if (event.type === 'permission.requested') {
    return {
      ...state,
      permissions: [
        ...state.permissions,
        {
          requestId: event.requestId,
          sessionId: event.sessionId,
          tool: event.tool,
          summary: event.summary,
          ...(event.preview ? { preview: event.preview } : {}),
        },
      ],
    };
  }

  // Escalation prompts can come from any descendant; they're answered at the top.
  if (event.type === 'escalation.requested' && event.sessionId !== state.sessionId) {
    const agent = agentOf(state, event.sessionId);
    return {
      ...state,
      escalations: [
        ...state.escalations,
        {
          requestId: event.requestId,
          reason: agent ? `${agent}: ${event.reason}` : event.reason,
          target: event.target,
          ...(event.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: event.estimatedCostUsd }
            : {}),
        },
      ],
    };
  }
  return reduceSession(state, event);
}

/** Fold an event into the session it belongs to: this one or a descendant. */
function reduceSession(state: ViewState, event: SessionEvent): ViewState {
  if (event.sessionId !== state.sessionId) {
    const entry = Object.entries(state.children).find(([, c]) => owns(c, event.sessionId));
    if (!entry) return state;
    const [id, child] = entry;
    const next = { ...state, children: { ...state.children, [id]: reduceSession(child, event) } };
    // Direct children also update their summary row here.
    return event.sessionId === id ? updateSubagentRow(next, event) : next;
  }

  const items = [...state.items];
  const last = items.at(-1);
  switch (event.type) {
    case 'turn.started':
      return { ...state, running: true };
    case 'route.decided':
      items.push({
        kind: 'route',
        id: `r${items.length}`,
        tier: event.tier,
        model: event.model,
        rule: event.rule,
        reason: event.reason,
      });
      return { ...state, items, lastTier: event.tier };
    case 'text.delta':
    case 'reasoning.delta': {
      const target =
        last?.kind === 'assistant'
          ? { ...last }
          : { kind: 'assistant' as const, id: `a${items.length}`, text: '', reasoning: '' };
      if (event.type === 'text.delta') target.text += event.text;
      else target.reasoning += event.text;
      if (last?.kind === 'assistant') items[items.length - 1] = target;
      else items.push(target);
      return { ...state, items };
    }
    case 'tool.started':
      items.push({
        kind: 'tool',
        id: event.callId,
        name: event.name,
        input: event.input,
        status: 'running',
      });
      return { ...state, items };
    case 'tool.completed': {
      const i = items.findIndex((it) => it.kind === 'tool' && it.id === event.callId);
      const updated = {
        kind: 'tool' as const,
        id: event.callId,
        name: event.name,
        input: undefined,
        status: event.isError ? ('error' as const) : ('ok' as const),
        output: event.output,
      };
      if (i >= 0)
        items[i] = {
          ...(items[i] as Extract<ViewItem, { kind: 'tool' }>),
          status: updated.status,
          output: event.output,
          ...(event.private ? { private: event.private } : {}),
        };
      else items.push({ ...updated, ...(event.private ? { private: event.private } : {}) });
      if (event.private && !state.private) {
        items.push({ kind: 'info', id: `p${items.length}`, text: privateLabel(event.private) });
        return { ...state, items, private: event.private };
      }
      return { ...state, items };
    }
    case 'subagent.started':
      items.push({
        kind: 'subagent',
        id: event.childSessionId,
        agent: event.agent,
        task: event.task,
        status: 'running',
        toolCalls: 0,
        ...(event.background ? { background: true } : {}),
      });
      return {
        ...state,
        items,
        children: {
          ...state.children,
          [event.childSessionId]: {
            ...initialView(event.childSessionId),
            items: [{ kind: 'user', id: 'task', text: event.task }],
            running: true,
          },
        },
      };
    case 'subagent.completed': {
      const i = items.findIndex((it) => it.kind === 'subagent' && it.id === event.childSessionId);
      if (i >= 0)
        items[i] = {
          ...(items[i] as Extract<ViewItem, { kind: 'subagent' }>),
          status: event.ok ? 'ok' : 'error',
        };
      if (event.background)
        items.push({
          kind: 'info',
          id: `b${event.childSessionId}`,
          text: `↳ background ${event.agent} ${event.ok ? 'finished' : 'failed'}; its report went to the agent`,
        });
      return { ...state, items };
    }
    case 'escalation.requested':
      return {
        ...state,
        escalations: [
          ...state.escalations,
          {
            requestId: event.requestId,
            reason: event.reason,
            target: event.target,
            ...(event.estimatedCostUsd !== undefined
              ? { estimatedCostUsd: event.estimatedCostUsd }
              : {}),
          },
        ],
      };
    case 'review.completed':
      items.push({
        kind: 'review',
        id: `v${items.length}`,
        verdict: event.verdict,
        summary: event.summary,
        issues: event.issues,
        round: event.round,
        ...(event.model ? { model: event.model } : {}),
      });
      return { ...state, items };
    case 'secrets.redacted':
      items.push({
        kind: 'info',
        id: `s${items.length}`,
        text: redactedLabel(event.kinds, event.model),
      });
      return { ...state, items };
    case 'context.compacted':
      items.push({
        kind: 'info',
        id: `c${items.length}`,
        text: compactedLabel(event.messages, event.tokensBefore, event.tokensAfter),
      });
      return { ...state, items };
    case 'usage.updated':
      return { ...state, costUsd: event.costUsd, savingsUsd: event.savingsUsd ?? state.savingsUsd };
    case 'error':
      items.push({ kind: 'error', id: `e${items.length}`, message: event.message });
      return { ...state, items };
    case 'turn.completed':
      return { ...state, running: false, permissions: [], escalations: [] };
  }
  return state;
}

type SessionEvent = Exclude<EngineEvent, { type: 'log' } | { type: 'config.updated' }>;

function updateSubagentRow(state: ViewState, event: SessionEvent): ViewState {
  const i = state.items.findIndex((it) => it.kind === 'subagent' && it.id === event.sessionId);
  if (i < 0) return state;
  const row = { ...(state.items[i] as Extract<ViewItem, { kind: 'subagent' }>) };
  if (event.type === 'route.decided') row.tier = event.tier;
  else if (event.type === 'tool.started') {
    row.toolCalls++;
    row.activity = event.name;
  } else return state;
  const items = [...state.items];
  items[i] = row;
  return { ...state, items };
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
