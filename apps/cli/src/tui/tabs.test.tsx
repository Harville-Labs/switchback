import { describe, expect, test } from 'bun:test';
import {
  dashboardRows,
  initialTabs,
  initialView,
  openTab,
  type SwitchbackClient,
} from '@switchback/client';
import type { EngineEvent, InitializeResult } from '@switchback/protocol';
import { render } from 'ink-testing-library';
import { App } from './App.tsx';
import { MouseContext } from './Clickable.tsx';
import type { ClickListener, MouseInput } from './mouse.ts';
import { tabAtColumn, tabSpans } from './Tabs.tsx';
import { frameWith, frameWithout, session, tick, until } from './test-support.ts';

const ENTER = '\r';
const TAB = '\t';
const CTRL_W = '\x17';
const ESC = '\x1b';
// What a terminal sends for alt+↓ and alt+↑ (xterm's modifier form).
const ALT_DOWN = '\x1b[1;3B';
const ALT_UP = '\x1b[1;3A';
// kitty's keyboard protocol: ctrl+tab and ctrl+shift+tab.
const CTRL_TAB = '\x1b[9;5u';
const CTRL_SHIFT_TAB = '\x1b[9;6u';

const init = {
  protocolVersion: 2,
  engineVersion: '0',
  workspaceRoot: '/tmp',
  models: [
    { alias: 'fast', ref: { provider: 'ollama', model: 'qwen3' }, tier: 'local' },
    { alias: 'opus', ref: { provider: 'anthropic', model: 'claude-opus-5' }, tier: 'remote' },
  ],
  agents: [],
} satisfies InitializeResult;
const roles = {
  current: ['fast'],
  escalate: [['opus']],
  review: { mode: 'off', models: [] },
  overridden: [],
};

function app() {
  const calls: { method: string; params: unknown }[] = [];
  let listener: ((e: EngineEvent) => void) | undefined;
  const clicks = new Set<ClickListener>();
  let created = 0;
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'permissions.list') return { modes: ['default'], levels: {}, rules: [] };
      if (method === 'usage.get') throw new Error('not needed');
      if (method === 'session.list') return [session('s1', 'fix the parser')];
      if (method === 'commands.list') return [];
      if (method === 'mcp.list') return { servers: [] };
      if (method === 'session.roles') return roles;
      if (method === 'session.setRoles') return { ...roles, ...(params as object) };
      if (method === 'session.create') return session(`new${++created}`, `tab ${created + 1}`);
      return {};
    },
    on: (l: (e: EngineEvent) => void) => {
      listener = l;
      return () => {};
    },
  } as unknown as SwitchbackClient;
  const mouse = {
    onWheel: () => () => {},
    onClick: (l: ClickListener) => {
      clicks.add(l);
      return () => clicks.delete(l);
    },
  } as unknown as MouseInput;
  const ui = render(
    <MouseContext.Provider value={mouse}>
      <App
        client={client}
        init={init}
        initialSession={session('s1', 'fix the parser')}
        initialRoute="auto"
        warnings={[]}
      />
    </MouseContext.Provider>,
  );
  const emit = (e: EngineEvent) => listener?.(e);
  return {
    ui,
    calls,
    emit,
    click: (x: number, y: number) => {
      for (const l of clicks) l(x, y);
    },
  };
}

/** Opens a second tab through the dashboard. */
async function secondTab(ui: ReturnType<typeof app>['ui']) {
  ui.stdin.write('\x14');
  await tick();
  ui.stdin.write('n');
  await frameWith(ui, '2 tab 2');
}

describe('the tab bar', () => {
  test('each tab covers its icon and label, after the padding and separators', () => {
    let tabs = initialTabs(session('a', 'one'), initialView('a'));
    tabs = openTab(tabs, session('b', 'two'));
    const spans = tabSpans(dashboardRows(tabs), 80);
    // Column 2: the icon, then " 1 one ".
    expect(spans.map((s) => [s.label, s.from, s.to])).toEqual([
      [' 1 one ', 2, 9],
      [' 2 two ', 13, 20],
    ]);
    expect(tabAtColumn(spans, 5)).toBe('a');
    expect(tabAtColumn(spans, 11)).toBeUndefined();
    expect(tabAtColumn(spans, 18)).toBe('b');
  });

  test('ctrl+tab and ctrl+shift+tab cycle tabs, a click picks one, ctrl+w closes it', async () => {
    const { ui, click } = app();
    await tick();
    await secondTab(ui);
    expect(ui.lastFrame()).toContain('2 tab 2');
    ui.stdin.write(CTRL_TAB);
    await tick();
    ui.stdin.write('/tab');
    await tick();
    ui.stdin.write(ENTER);
    // With no argument, /tab opens the sessions list on the tab in front.
    expect(await frameWith(ui, /› +1 · fix the parser .*here/)).toMatch(/› +1 · fix the parser/);
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write(CTRL_SHIFT_TAB);
    await tick();
    ui.stdin.write('/tab');
    await tick();
    ui.stdin.write(ENTER);
    expect(await frameWith(ui, /› +2 · tab 2 .*here/)).toMatch(/› +2 · tab 2/);
    ui.stdin.write(ESC);
    await tick();
    click(4, 1);
    await tick();
    ui.stdin.write('/tab');
    await tick();
    ui.stdin.write(ENTER);
    expect(await frameWith(ui, /› +1 · fix the parser .*here/)).toMatch(/› +1 · fix the parser/);
    ui.stdin.write(ESC);
    await tick();
    // With text typed, ctrl+w deletes a word; on an empty prompt it closes the tab.
    ui.stdin.write('draft');
    await tick();
    ui.stdin.write(CTRL_W);
    await tick();
    expect(ui.lastFrame()).toContain('2 tab 2');
    ui.stdin.write(CTRL_W);
    expect(await frameWithout(ui, '2 tab 2')).not.toContain('2 tab 2');
  }, 20_000);
});

describe('the subagent view', () => {
  test('alt+↓ shows a subagent in place of the session; /model there picks the subagent model', async () => {
    const { ui, calls, emit } = app();
    await tick();
    emit({ type: 'turn.started', sessionId: 's1', turnId: 't' });
    emit({
      type: 'subagent.started',
      sessionId: 's1',
      childSessionId: 'c1',
      agent: 'explore',
      task: 'find the parser',
    });
    emit({
      type: 'text.delta',
      sessionId: 'c1',
      parentSessionId: 's1',
      turnId: 'c',
      text: 'looking in src/',
    });
    await tick();
    ui.stdin.write(ALT_DOWN);
    // The status bar can show the subagent a frame before the transcript does.
    const frame = await frameWith(ui, '↳ explore · find the parser');
    expect(frame).toContain('↳ explore · find the parser');
    expect(frame).toContain('↳ viewing explore');
    expect(await frameWith(ui, 'looking in src/')).toContain('looking in src/');
    ui.stdin.write('/model');
    await tick();
    ui.stdin.write(ENTER);
    expect(await frameWith(ui, 'Subagent model')).toContain('Subagent model');
    ui.stdin.write('2');
    await until(() => calls.some((c) => c.method === 'session.setRoles'));
    expect(calls.find((c) => c.method === 'session.setRoles')?.params).toMatchObject({
      subagents: 'opus',
    });
    // alt+↑ comes back to the session.
    ui.stdin.write(ALT_UP);
    await tick();
    expect(await frameWithout(ui, '↳ viewing explore')).not.toContain('↳ viewing explore');
  }, 20_000);

  test('a click on a model in the picker switches to it; one on esc closes it', async () => {
    const { ui, calls, click } = app();
    await tick();
    const at = (text: string) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the frame's colors
      const lines = (ui.lastFrame() ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n');
      const y = lines.findIndex((l) => l.includes(text));
      return [(lines[y] ?? '').indexOf(text) + 1, y + 1] as const;
    };
    ui.stdin.write('/model');
    await tick();
    ui.stdin.write(ENTER);
    await frameWith(ui, 'Current model');
    click(...at('esc close'));
    expect(await frameWithout(ui, 'Current model')).not.toContain('Current model');
    ui.stdin.write('/model');
    await tick();
    ui.stdin.write(ENTER);
    await frameWith(ui, 'Current model');
    click(...at('2. opus'));
    await until(() => calls.some((c) => c.method === 'session.setRoles'));
    expect(calls.find((c) => c.method === 'session.setRoles')?.params).toMatchObject({
      current: ['opus', 'fast'],
    });
  }, 20_000);

  test('Tab switches to the next model and says so', async () => {
    const { ui, calls } = app();
    await tick();
    ui.stdin.write(TAB);
    await tick();
    expect(calls.find((c) => c.method === 'session.setRoles')?.params).toMatchObject({
      current: [expect.any(String)],
    });
    expect(await frameWith(ui, 'Switched to')).toContain('Switched to');
  });
});
