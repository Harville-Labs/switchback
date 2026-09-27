/**
 * Shared view model. Folds engine events into what a UI should display. The
 * TUI and the VS Code webview both render from this reducer, so they cannot
 * disagree about what happened in a session.
 */
import type {
  EngineEvent,
  Message,
  ModelRef,
  PermissionDecision,
  SessionSummary,
  Tier,
  UsageReport,
} from '@harness/protocol';

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
  lastTier?: Tier;
}

export function initialView(sessionId: string): ViewState {
  return { sessionId, items: [], running: false, permissions: [], escalations: [], costUsd: 0 };
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
        if (p.type === 'text' && p.attachment)
          items.push({
            kind: 'info',
            id: `h${mi}f${p.attachment.path}`,
            text: `📎 ${p.attachment.path}`,
          });
        else if (p.type === 'text') items.push({ kind: 'user', id: `h${mi}u`, text: p.text });
        else if (p.type === 'tool_result') {
          const t = tools.get(p.callId);
          if (t) {
            t.status = p.isError ? 'error' : 'ok';
            t.output = p.content;
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
  return {
    ...initialView(session.id),
    items,
    // Joining a session mid-turn: the live events that follow will finish it.
    running: !!session.running,
    costUsd: session.costUsd,
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

  // Events from subagents update their summary row in the parent's view.
  if (event.sessionId !== state.sessionId) {
    return updateSubagent(state, event);
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
        };
      else items.push(updated);
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
      });
      return { ...state, items };
    case 'subagent.completed': {
      const i = items.findIndex((it) => it.kind === 'subagent' && it.id === event.childSessionId);
      if (i >= 0)
        items[i] = {
          ...(items[i] as Extract<ViewItem, { kind: 'subagent' }>),
          status: event.ok ? 'ok' : 'error',
        };
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
    case 'usage.updated':
      return { ...state, costUsd: event.costUsd };
    case 'error':
      items.push({ kind: 'error', id: `e${items.length}`, message: event.message });
      return { ...state, items };
    case 'turn.completed':
      return { ...state, running: false, permissions: [], escalations: [] };
  }
  return state;
}

function updateSubagent(
  state: ViewState,
  event: Exclude<EngineEvent, { type: 'log' } | { type: 'config.updated' }>,
): ViewState {
  const i = state.items.findIndex((it) => it.kind === 'subagent' && it.id === event.sessionId);
  if (i < 0) return state;
  const row = { ...(state.items[i] as Extract<ViewItem, { kind: 'subagent' }>) };
  if (event.type === 'route.decided') row.tier = event.tier;
  else if (event.type === 'tool.started') {
    row.toolCalls++;
    row.activity = event.name;
  } else if (event.type === 'escalation.requested') {
    return {
      ...state,
      escalations: [
        ...state.escalations,
        {
          requestId: event.requestId,
          reason: `${row.agent}: ${event.reason}`,
          target: event.target,
          ...(event.estimatedCostUsd !== undefined
            ? { estimatedCostUsd: event.estimatedCostUsd }
            : {}),
        },
      ],
    };
  } else return state;
  const items = [...state.items];
  items[i] = row;
  return { ...state, items };
}

export type UsageBreakdown = 'rule' | 'agent' | 'model';

/**
 * Plain-text usage summary shared by `harness usage`, the TUI's `/usage`, and
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
