/**
 * Shared view model. Folds engine events into what a UI should display. The
 * TUI and the VS Code webview both render from this reducer, so they cannot
 * disagree about what happened in a session.
 */
import type {
  EngineEvent,
  Message,
  PermissionDecision,
  SessionSummary,
} from '@switchback/protocol';
import { compactedLabel, privateLabel, redactedLabel } from './format.ts';
import {
  agentOf,
  initialView,
  owns,
  type TodoItem,
  todoItems,
  type ViewItem,
  type ViewState,
} from './view-state.ts';

export * from './view-state.ts';

/**
 * Rebuild a view from a stored transcript, for resuming a session. Routing
 * rows use the rule `history`; reasoning is not replayed into the view.
 */
export function fromTranscript(session: SessionSummary, messages: Message[]): ViewState {
  const items: ViewItem[] = [];
  const tools = new Map<string, Extract<ViewItem, { kind: 'tool' }>>();
  let todos: TodoItem[] | undefined;
  messages.forEach((m, mi) => {
    if (m.role === 'user') {
      for (const p of m.parts) {
        if (p.type === 'text' && p.reminder) continue;
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
        else if (p.type === 'image')
          items.push({
            kind: 'image',
            id: `h${mi}i${p.attachment?.path ?? ''}`,
            name: p.attachment?.path ?? 'image',
            src: `data:${p.mediaType};base64,${p.data}`,
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
        if (p.name === 'todo') todos = todoItems(p.input) ?? todos;
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
    ...(todos ? { todos } : {}),
    ...(session.permissionMode ? { mode: session.permissionMode } : {}),
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

/** Record a prompt the user just sent (the engine does not echo it). */
/** A prompt the user just sent, with the images attached to it. */
export function addUserPrompt(
  state: ViewState,
  text: string,
  images: { name: string; src?: string }[] = [],
): ViewState {
  const n = state.items.length;
  return {
    ...state,
    running: true,
    items: [
      ...state.items,
      { kind: 'user', id: `u${n}`, text },
      ...images.map((i, k) => ({ kind: 'image' as const, id: `u${n}i${k}`, ...i })),
    ],
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

  // Shells from any session in the tree; the status line counts the running ones.
  if (event.type === 'shell.updated') {
    if (!owns(state, event.sessionId)) return state;
    return { ...state, shells: { ...state.shells, [event.shell.id]: event.shell } };
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
          ...(event.rules ? { rules: event.rules } : {}),
          ...(event.askRule ? { askRule: event.askRule } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
          ...(event.plan ? { plan: event.plan } : {}),
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
      return {
        ...state,
        items,
        lastTier: event.tier,
        ...(event.inputTokens !== undefined && event.contextWindow
          ? { context: { tokens: event.inputTokens, window: event.contextWindow } }
          : {}),
        ...(event.step !== undefined
          ? {
              ladder: {
                step: event.step,
                steps: event.steps ?? 0,
                model: event.model.model,
                ...(event.stickyTurns !== undefined ? { stickyTurns: event.stickyTurns } : {}),
              },
            }
          : {}),
      };
    case 'roles.updated':
      return { ...state, roles: event.roles };
    case 'mode.changed':
      return { ...state, mode: event.mode };
    case 'queue.updated':
      return { ...state, queue: event.queued };
    case 'queue.delivered':
      // The prompt joins the conversation now, not when it was typed.
      items.push({ kind: 'user', id: `q${event.prompt.id}`, text: event.prompt.text });
      return { ...state, items };
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
    case 'tool.started': {
      items.push({
        kind: 'tool',
        id: event.callId,
        name: event.name,
        input: event.input,
        status: 'running',
      });
      const todos = event.name === 'todo' ? todoItems(event.input) : undefined;
      return { ...state, items, ...(todos ? { todos } : {}) };
    }
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
      const extra = {
        ...(event.private ? { private: event.private } : {}),
        ...(event.denied ? { denied: true } : {}),
        ...(event.diff ? { diff: event.diff } : {}),
      };
      if (i >= 0)
        items[i] = {
          ...(items[i] as Extract<ViewItem, { kind: 'tool' }>),
          status: updated.status,
          output: event.output,
          ...extra,
        };
      else items.push({ ...updated, ...extra });
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
    case 'call.stats': {
      if (event.tokensPerSecond === undefined) return state;
      // The route row for this call is the latest one: calls in a session run one at a time.
      const at = items.findLastIndex((i) => i.kind === 'route');
      const row = items[at];
      if (row?.kind === 'route') items[at] = { ...row, tokensPerSecond: event.tokensPerSecond };
      return {
        ...state,
        items,
        speed: { model: event.model.model, tokensPerSecond: event.tokensPerSecond },
      };
    }
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
