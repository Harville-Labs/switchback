import { describe, expect, test } from 'bun:test';
import type { EngineEvent, SessionSummary } from '@switchback/protocol';
import {
  activeView,
  closeTab,
  cycleTab,
  dashboardRows,
  formatDashboard,
  initialTabs,
  openTab,
  reduceTabs,
  replaceActive,
  switchTab,
  tabsNeedingYou,
  tabTitle,
  trackSessions,
} from './tabs.ts';
import { addUserPrompt } from './view.ts';

const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  title: '',
  agent: 'build',
  createdAt: '',
  updatedAt: '',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  ...extra,
});

const local = { provider: 'ollama', model: 'coder' };
const fold = (state: ReturnType<typeof initialTabs>, events: EngineEvent[]) =>
  events.reduce(reduceTabs, state);

describe('tabs', () => {
  test('open, switch, cycle, and close', () => {
    let s = initialTabs(summary('a'));
    s = openTab(s, summary('b'));
    expect(s.active).toBe('b');
    s = openTab(s, summary('c'));
    expect(s.tabs.map((t) => t.session.id)).toEqual(['a', 'b', 'c']);
    expect(cycleTab(s, 1).active).toBe('a');
    expect(cycleTab(s, -1).active).toBe('b');
    // Opening one that's open brings it forward instead of adding another.
    expect(openTab(s, summary('a')).tabs).toHaveLength(3);
    expect(openTab(s, summary('a')).active).toBe('a');
    s = closeTab(s, 'c');
    expect(s.active).toBe('b');
    s = closeTab(closeTab(s, 'b'), 'a');
    // The last tab stays.
    expect(s.tabs.map((t) => t.session.id)).toEqual(['a']);
  });

  test('a new tab opens next to the one in front', () => {
    let s = openTab(openTab(initialTabs(summary('a')), summary('b')), summary('c'));
    s = openTab(switchTab(s, 'a'), summary('d'));
    expect(s.tabs.map((t) => t.session.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  test("events reach their own tab, and a background tab's view stays live", () => {
    let s = openTab(initialTabs(summary('a')), summary('b'));
    s = fold(s, [
      { type: 'turn.started', sessionId: 'a', turnId: 't1' },
      { type: 'text.delta', sessionId: 'a', turnId: 't1', text: 'hello' },
    ]);
    const a = s.tabs.find((t) => t.session.id === 'a')?.view;
    expect(a?.items.at(-1)).toMatchObject({ kind: 'assistant', text: 'hello' });
    expect(activeView(s).items).toEqual([]);
  });

  test("a permission prompt from one session doesn't show in another's tab", () => {
    let s = openTab(initialTabs(summary('a')), summary('b'));
    s = reduceTabs(s, {
      type: 'permission.requested',
      sessionId: 'a',
      requestId: 'p1',
      tool: 'bash',
      summary: 'rm -rf build',
      input: {},
    });
    expect(activeView(s).permissions).toEqual([]);
    expect(s.tabs[0]?.view.permissions).toHaveLength(1);
    expect(tabsNeedingYou(dashboardRows(s))).toBe(1);
  });

  test("a subagent's prompt goes to the tab of the session it works for", () => {
    let s = openTab(initialTabs(summary('a')), summary('b'));
    s = fold(s, [
      { type: 'turn.started', sessionId: 'a', turnId: 't1' },
      {
        type: 'subagent.started',
        sessionId: 'a',
        childSessionId: 'kid',
        agent: 'explore',
        task: 'look',
      },
      {
        type: 'permission.requested',
        sessionId: 'grandkid',
        parentSessionId: 'kid',
        requestId: 'p1',
        tool: 'bash',
        summary: 'ls',
        input: {},
      },
    ]);
    expect(s.tabs[0]?.view.permissions).toHaveLength(1);
    expect(s.sessions.a?.waiting).toEqual(['p1']);
    s = reduceTabs(s, {
      type: 'permission.resolved',
      sessionId: 'grandkid',
      parentSessionId: 'kid',
      requestId: 'p1',
      decision: 'allow_once',
    });
    expect(s.sessions.a?.waiting).toEqual([]);
  });

  test('the dashboard says what each session is doing and on which model', () => {
    let s = openTab(initialTabs(summary('a', { title: 'fix retry' })), summary('b'));
    s = fold(s, [
      { type: 'turn.started', sessionId: 'a', turnId: 't1' },
      {
        type: 'route.decided',
        sessionId: 'a',
        turnId: 't1',
        tier: 'local',
        model: local,
        rule: 'default',
        reason: 'the current model',
      },
      {
        type: 'tool.started',
        sessionId: 'a',
        turnId: 't1',
        callId: 'c1',
        name: 'bash',
        input: { command: 'bun test' },
      },
    ]);
    const [a] = dashboardRows(s);
    expect(a).toMatchObject({
      tab: 1,
      title: 'fix retry',
      state: 'running',
      model: 'coder',
      tier: 'local',
      doing: 'Bash bun test',
    });
    expect(formatDashboard(dashboardRows(s))).toContain('working · ⌂ coder · Bash bun test');
  });

  test('a turn that finishes in the back is news until its tab comes forward', () => {
    let s = openTab(initialTabs(summary('a')), summary('b'));
    s = fold(s, [
      { type: 'turn.started', sessionId: 'a', turnId: 't1' },
      { type: 'turn.completed', sessionId: 'a', turnId: 't1', stopReason: 'error' },
    ]);
    expect(dashboardRows(s)[0]?.state).toBe('failed');
    s = switchTab(s, 'a');
    expect(s.sessions.a?.ended).toBeUndefined();
    // Seen, it's idle from then on, in front or not.
    expect(dashboardRows(switchTab(s, 'b'))[0]?.state).toBe('idle');
  });

  test('sessions working in other windows are listed after the tabs; idle ones are not', () => {
    let s = initialTabs(summary('a'));
    s = trackSessions(s, [
      summary('a'),
      summary('elsewhere', { title: 'docs pass', running: true }),
      summary('old', { title: 'yesterday' }),
      summary('kid', { parentId: 'elsewhere', running: true }),
    ]);
    const rows = dashboardRows(s);
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'elsewhere']);
    expect(rows[1]).toMatchObject({ title: 'docs pass', state: 'running' });
    expect(formatDashboard(rows)).toContain('Working in other windows');
  });

  test('a tab is named by its title, else its first prompt', () => {
    const s = initialTabs(summary('a'));
    expect(tabTitle(s.tabs[0]?.session)).toBe('new session');
    expect(tabTitle(summary('a'), addUserPrompt(activeView(s), 'where is the retry logic?'))).toBe(
      'where is the retry logic?',
    );
  });

  test('replacing the session in front keeps the other tabs', () => {
    let s = openTab(initialTabs(summary('a')), summary('b'));
    s = replaceActive(s, summary('c'));
    expect(s.tabs.map((t) => t.session.id)).toEqual(['a', 'c']);
    expect(s.active).toBe('c');
    // Resuming a session that's already open switches to its tab instead.
    expect(replaceActive(s, summary('a')).tabs).toHaveLength(2);
  });
});
