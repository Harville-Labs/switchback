import { describe, expect, test } from 'bun:test';
import type { SwitchbackClient } from '@switchback/client';
import type { InitializeResult, SessionSummary } from '@switchback/protocol';
import { render } from 'ink-testing-library';
import { App } from './App.tsx';
import { PromptInput } from './PromptInput.tsx';
import { filterSessions, SessionPicker } from './SessionPicker.tsx';

const CTRL_C = '\x03';
const ENTER = '\r';
const tick = () => new Promise((r) => setTimeout(r, 20));

const session = (id: string, title: string, agent = 'build'): SessionSummary => ({
  id,
  title,
  agent,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
});

describe('Ctrl+C in the prompt', () => {
  test('clears what is typed, and only an empty prompt interrupts', async () => {
    let interrupts = 0;
    const ui = render(
      <PromptInput
        focus
        busy={false}
        placeholder="Ask"
        history={[]}
        root="/tmp"
        onSubmit={() => {}}
        onInterrupt={() => interrupts++}
      />,
    );
    ui.stdin.write('a long pasted prompt');
    await tick();
    expect(ui.lastFrame()).toContain('a long pasted prompt');
    ui.stdin.write(CTRL_C);
    await tick();
    expect(ui.lastFrame()).not.toContain('a long pasted prompt');
    expect(interrupts).toBe(0);
    ui.stdin.write(CTRL_C);
    await tick();
    expect(interrupts).toBe(1);
  });
});

describe('Ctrl+C in the app', () => {
  const init = {
    protocolVersion: 1,
    engineVersion: '0',
    workspaceRoot: '/tmp',
    models: [],
    agents: [],
  } satisfies InitializeResult;

  function app() {
    const calls: string[] = [];
    const client = {
      request: async (method: string) => {
        calls.push(method);
        if (method === 'permissions.list') return { modes: ['default'], levels: {}, rules: [] };
        if (method === 'usage.get') throw new Error('not needed');
        if (method === 'session.list') return [session('s2', 'fix the parser')];
        return {};
      },
      on: () => () => {},
    } as unknown as SwitchbackClient;
    const ui = render(
      <App
        client={client}
        init={init}
        initialSession={session('s1', '')}
        initialRoute="auto"
        warnings={[]}
      />,
    );
    return { ui, calls };
  }

  test('an idle, empty prompt asks for a second press before quitting', async () => {
    const { ui } = app();
    await tick();
    ui.stdin.write(CTRL_C);
    await tick();
    expect(ui.lastFrame()).toContain('Press Ctrl+C again to exit');
  });

  test('/resume with no argument opens the session picker', async () => {
    const { ui, calls } = app();
    await tick();
    ui.stdin.write('/resume');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    expect(calls).toContain('session.list');
    expect(ui.lastFrame()).toContain('Resume a session');
    expect(ui.lastFrame()).toContain('fix the parser');
  });
});

describe('session picker', () => {
  const all = [session('a1', 'fix the parser'), session('b2', 'write docs', 'explore')];

  test('filters by every typed word across title, agent, and ID', () => {
    expect(filterSessions(all, 'parser').map((s) => s.id)).toEqual(['a1']);
    expect(filterSessions(all, 'explore docs').map((s) => s.id)).toEqual(['b2']);
    expect(filterSessions(all, '')).toHaveLength(2);
  });

  test('typing filters, Enter opens the selection, Esc closes', async () => {
    const picked: string[] = [];
    let cancelled = false;
    const ui = render(
      <SessionPicker
        sessions={all}
        current="a1"
        onPick={(id) => picked.push(id)}
        onCancel={() => {
          cancelled = true;
        }}
      />,
    );
    ui.stdin.write('docs');
    await tick();
    expect(ui.lastFrame()).not.toContain('fix the parser');
    ui.stdin.write(ENTER);
    await tick();
    expect(picked).toEqual(['b2']);
    ui.stdin.write('\x1b');
    await tick();
    expect(cancelled).toBe(true);
  });
});
