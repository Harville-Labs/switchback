/**
 * Multiplexing: several sessions open at once, as tabs, and a dashboard of
 * every session that's working or waiting in this workspace, including ones
 * open in other windows on the shared engine. Both clients keep their tabs
 * with these functions, so a background tab's view stays live and both show
 * the same states with the same words.
 *
 * The engine sends every client every session's events; this folds each one
 * into the tab it belongs to and into a per-session summary for the dashboard.
 */
import type { EngineEvent, SessionSummary, Tier } from '@switchback/protocol';
import { tierIcon } from './format.ts';
import { toolTitle } from './tool-display.ts';
import { reduce } from './view.ts';
import { initialView, owns, type ViewState } from './view-state.ts';

export interface Tab {
  session: SessionSummary;
  view: ViewState;
}

/** What a session needs from the user, most urgent first. */
export type SessionState = 'waiting' | 'running' | 'failed' | 'done' | 'idle';

/** A top-level session as the dashboard sees it, from its events. */
export interface SessionActivity {
  sessionId: string;
  title: string;
  agent: string;
  running: boolean;
  /** Prompts waiting for an answer (permission, plan, escalation), by request ID. */
  waiting: string[];
  model?: string;
  tier?: Tier;
  costUsd: number;
  /** What it's doing now: `Bash bun test`, `Writing`, `Waiting on explore`. */
  doing?: string;
  /** How its last turn ended while it wasn't the tab in front, until it's looked at. */
  ended?: 'done' | 'failed';
}

export interface TabsState {
  tabs: Tab[];
  /** The tab in front, by session ID. */
  active: string;
  /** Every top-level session seen, open in a tab or not. */
  sessions: Record<string, SessionActivity>;
  /** Subagent session to the top-level session it works for. */
  roots: Record<string, string>;
}

export function initialTabs(session: SessionSummary, view?: ViewState): TabsState {
  return {
    tabs: [{ session, view: view ?? initialView(session.id) }],
    active: session.id,
    sessions: { [session.id]: activityOf(session) },
    roots: {},
  };
}

function activityOf(s: SessionSummary, prev?: SessionActivity): SessionActivity {
  return {
    waiting: [],
    ...prev,
    sessionId: s.id,
    title: s.title,
    agent: s.agent,
    running: !!s.running,
    costUsd: s.costUsd,
  };
}

export function activeTab(state: TabsState): Tab {
  // `active` always names a tab; the fallback only keeps the type honest.
  return (state.tabs.find((t) => t.session.id === state.active) ?? state.tabs[0]) as Tab;
}

export function activeView(state: TabsState): ViewState {
  return activeTab(state).view;
}

/** Change one tab's view. */
export function updateView(
  state: TabsState,
  sessionId: string,
  update: (v: ViewState) => ViewState,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.session.id === sessionId ? { ...t, view: update(t.view) } : t)),
  };
}

export function updateActiveView(state: TabsState, update: (v: ViewState) => ViewState): TabsState {
  return updateView(state, state.active, update);
}

/**
 * Put another session in the tab in front (`/new`, `/resume`, rewind), in
 * place of the one there. That session keeps running if it was; the
 * dashboard still shows it.
 */
export function replaceActive(
  state: TabsState,
  session: SessionSummary,
  update: (v: ViewState) => ViewState = () => initialView(session.id),
): TabsState {
  const open = state.tabs.find((t) => t.session.id === session.id);
  if (open && open.session.id !== state.active) return switchTab(state, session.id);
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.session.id === state.active ? { session, view: update(t.view) } : t,
    ),
    active: session.id,
    sessions: { ...state.sessions, [session.id]: activityOf(session, state.sessions[session.id]) },
  };
}

/** Open a session in a new tab in front, or bring its tab forward if it's open already. */
export function openTab(state: TabsState, session: SessionSummary, view?: ViewState): TabsState {
  if (state.tabs.some((t) => t.session.id === session.id)) return switchTab(state, session.id);
  const at = state.tabs.findIndex((t) => t.session.id === state.active) + 1;
  const tab = { session, view: view ?? initialView(session.id) };
  return switchTab(
    {
      ...state,
      tabs: [...state.tabs.slice(0, at), tab, ...state.tabs.slice(at)],
      sessions: {
        ...state.sessions,
        [session.id]: activityOf(session, state.sessions[session.id]),
      },
    },
    session.id,
  );
}

/** Bring a tab forward; what it finished while in the back counts as seen. */
export function switchTab(state: TabsState, sessionId: string): TabsState {
  if (!state.tabs.some((t) => t.session.id === sessionId)) return state;
  const seen = state.sessions[sessionId];
  return {
    ...state,
    active: sessionId,
    ...(seen?.ended
      ? { sessions: { ...state.sessions, [sessionId]: { ...seen, ended: undefined } } }
      : {}),
  };
}

/** The tab `delta` places along, wrapping around. */
export function cycleTab(state: TabsState, delta: number): TabsState {
  const n = state.tabs.length;
  const at = state.tabs.findIndex((t) => t.session.id === state.active);
  const next = state.tabs[(((at + delta) % n) + n) % n];
  return next ? switchTab(state, next.session.id) : state;
}

/** The `n`th tab (1-based), as numbered in the tab bar. */
export function tabAt(state: TabsState, n: number): Tab | undefined {
  return state.tabs[n - 1];
}

/**
 * Close a tab. The session isn't stopped: a running turn goes on in the
 * background and stays on the dashboard. The last tab can't be closed.
 */
export function closeTab(state: TabsState, sessionId: string): TabsState {
  const at = state.tabs.findIndex((t) => t.session.id === sessionId);
  if (at < 0 || state.tabs.length === 1) return state;
  const tabs = state.tabs.filter((t) => t.session.id !== sessionId);
  if (state.active !== sessionId) return { ...state, tabs };
  const next = tabs[Math.min(at, tabs.length - 1)] as Tab;
  return switchTab({ ...state, tabs, active: next.session.id }, next.session.id);
}

/** Bring titles, costs, and running flags up to date from `session.list`. */
export function trackSessions(state: TabsState, sessions: SessionSummary[]): TabsState {
  const known = { ...state.sessions };
  for (const s of sessions) if (!s.parentId) known[s.id] = activityOf(s, known[s.id]);
  // A tab's summary follows too, so its title appears once the engine has one.
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    ...state,
    sessions: known,
    tabs: state.tabs.map((t) => {
      const s = byId.get(t.session.id);
      return s ? { ...t, session: s } : t;
    }),
  };
}

/** The top-level session an event's session works for. */
function rootOf(state: TabsState, sessionId: string): string {
  return state.roots[sessionId] ?? sessionId;
}

/** Fold an event into the tab it belongs to and into the dashboard. */
export function reduceTabs(state: TabsState, event: EngineEvent): TabsState {
  if (!('sessionId' in event)) {
    // Configuration notices show once, in the tab in front.
    const view = activeView(state);
    const next = reduce(view, event);
    return next === view ? state : updateActiveView(state, () => next);
  }
  let roots = state.roots;
  if (event.parentSessionId && !roots[event.sessionId])
    roots = { ...roots, [event.sessionId]: rootOf(state, event.parentSessionId) };
  if (event.type === 'subagent.started')
    roots = { ...roots, [event.childSessionId]: roots[event.sessionId] ?? event.sessionId };
  const next = { ...state, roots };
  const root = rootOf(next, event.sessionId);

  const tabs = state.tabs.map((t) => {
    const tab =
      event.type === 'session.renamed' && t.session.id === event.sessionId
        ? { ...t, session: { ...t.session, title: event.title } }
        : t;
    return owns(t.view, event.sessionId) ||
      (event.parentSessionId && owns(t.view, event.parentSessionId)) ||
      t.session.id === root
      ? { ...tab, view: reduce(t.view, event) }
      : tab;
  });
  const before = state.sessions[root];
  const after = activity(before ?? blankActivity(root), event, root, root === state.active);
  return {
    ...next,
    tabs: tabs.every((t, i) => t === state.tabs[i]) ? state.tabs : tabs,
    sessions: after === before ? state.sessions : { ...state.sessions, [root]: after },
  };
}

function blankActivity(sessionId: string): SessionActivity {
  return { sessionId, title: '', agent: '', running: false, waiting: [], costUsd: 0 };
}

function activity(
  a: SessionActivity,
  event: Extract<EngineEvent, { sessionId: string }>,
  root: string,
  inFront: boolean,
): SessionActivity {
  const own = event.sessionId === root;
  switch (event.type) {
    case 'turn.started':
      return own ? { ...a, running: true, doing: 'Working', ended: undefined } : a;
    case 'turn.completed': {
      if (!own) return a;
      const { doing: _done, ...rest } = a;
      const ended =
        inFront || event.stopReason === 'cancelled'
          ? undefined
          : event.stopReason === 'error'
            ? 'failed'
            : 'done';
      return { ...rest, running: false, ...(ended ? { ended } : {}) };
    }
    case 'permission.requested':
    case 'escalation.requested':
      return { ...a, waiting: [...a.waiting, event.requestId] };
    case 'permission.resolved':
    case 'escalation.resolved':
      return a.waiting.includes(event.requestId)
        ? { ...a, waiting: a.waiting.filter((id) => id !== event.requestId) }
        : a;
    case 'route.decided':
      return own ? { ...a, model: event.model.model, tier: event.tier } : a;
    case 'usage.updated':
      return own ? { ...a, costUsd: event.costUsd } : a;
    case 'tool.started': {
      if (!own) return a;
      const t = toolTitle(event.name, event.input);
      return { ...a, doing: clip(`${t.verb} ${t.target}`.trim()) };
    }
    case 'text.delta':
      return own && a.doing !== 'Writing' ? { ...a, doing: 'Writing' } : a;
    case 'reasoning.delta':
      return own && a.doing !== 'Thinking' ? { ...a, doing: 'Thinking' } : a;
    case 'subagent.started':
      return own ? { ...a, doing: `Waiting on ${event.agent}` } : a;
    case 'session.renamed':
      return own ? { ...a, title: event.title } : a;
    default:
      return a;
  }
}

function clip(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** A row of the dashboard: an open tab, or a session working in another window. */
export interface DashboardRow {
  sessionId: string;
  /** Its number in the tab bar, when it's open here. */
  tab?: number;
  active: boolean;
  title: string;
  agent: string;
  state: SessionState;
  model?: string;
  tier?: Tier;
  costUsd: number;
  doing?: string;
}

/**
 * The dashboard: open tabs in tab order, then sessions open elsewhere that
 * are working or waiting, most urgent first. Idle sessions that aren't open
 * are in the saved session list instead (`/resume`).
 */
export function dashboardRows(state: TabsState): DashboardRow[] {
  const open = state.tabs.map((t, i) => row(state, t.session.id, t, i + 1));
  const others = Object.values(state.sessions)
    .filter((a) => !state.tabs.some((t) => t.session.id === a.sessionId))
    .map((a) => row(state, a.sessionId))
    .filter((r) => r.state === 'running' || r.state === 'waiting');
  return [...open, ...others.sort((x, y) => RANK[x.state] - RANK[y.state])];
}

const RANK: Record<SessionState, number> = { waiting: 0, running: 1, failed: 2, done: 3, idle: 4 };

function row(state: TabsState, sessionId: string, tab?: Tab, n?: number): DashboardRow {
  const a = state.sessions[sessionId];
  const view = tab?.view;
  const waiting = !!a?.waiting.length || !!view?.permissions.length || !!view?.escalations.length;
  const running = view ? view.running : !!a?.running;
  const status: SessionState = waiting ? 'waiting' : running ? 'running' : (a?.ended ?? 'idle');
  const model = a?.model ?? view?.ladder?.model;
  const tier = a?.tier ?? view?.lastTier;
  return {
    sessionId,
    ...(n ? { tab: n } : {}),
    active: sessionId === state.active,
    title: tabTitle(tab?.session ?? a, view),
    agent: tab?.session.agent ?? a?.agent ?? '',
    // A finished tab in front reads as idle: there's nothing new to look at.
    state: status === 'done' && sessionId === state.active ? 'idle' : status,
    ...(model ? { model } : {}),
    ...(tier ? { tier } : {}),
    costUsd: view?.costUsd || a?.costUsd || 0,
    ...(running && a?.doing ? { doing: a.doing } : {}),
  };
}

/** A tab's name: the session's title, else its first prompt, else `new session`. */
export function tabTitle(
  session: Pick<SessionSummary, 'title'> | undefined,
  view?: ViewState,
  max = 40,
): string {
  const first = view?.items.find((i) => i.kind === 'user');
  const text = session?.title || (first?.kind === 'user' ? first.text : '') || 'new session';
  return clip(text, max);
}

export const STATE_ICONS: Record<SessionState, string> = {
  waiting: '?',
  running: '●',
  failed: '✗',
  done: '✓',
  idle: '·',
};

export const STATE_LABELS: Record<SessionState, string> = {
  waiting: 'waiting for you',
  running: 'working',
  failed: 'stopped with an error',
  done: 'finished',
  idle: 'idle',
};

/** How many open tabs, other than the one in front, need the user or have news. */
export function tabsNeedingYou(rows: DashboardRow[]): number {
  return rows.filter((r) => !r.active && (r.state === 'waiting' || r.state === 'failed')).length;
}

/** The dashboard as text, for `/tabs` and status lines. */
export function formatDashboard(rows: DashboardRow[]): string {
  const width = Math.min(40, Math.max(12, ...rows.map((r) => r.title.length)));
  const line = (r: DashboardRow) => {
    const where = r.tab ? `${String(r.tab).padStart(2)}${r.active ? '*' : ' '}` : '   ';
    const model = r.model ? ` · ${tierIcon(r.tier)} ${r.model}` : '';
    const cost = r.costUsd >= 0.0005 ? ` · $${r.costUsd.toFixed(3)}` : '';
    const doing = r.doing ? ` · ${r.doing}` : '';
    return `${where} ${STATE_ICONS[r.state]} ${r.title.padEnd(width)}  ${STATE_LABELS[r.state]}${model}${doing}${cost}`;
  };
  const open = rows.filter((r) => r.tab);
  const elsewhere = rows.filter((r) => !r.tab);
  return [
    'Tabs',
    ...open.map(line),
    ...(elsewhere.length ? ['Working in other windows', ...elsewhere.map(line)] : []),
  ].join('\n');
}
