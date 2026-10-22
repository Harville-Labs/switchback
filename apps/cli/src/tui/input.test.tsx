import { describe, expect, test } from 'bun:test';
import { customCommands, type SwitchbackClient } from '@switchback/client';
import type { InitializeResult } from '@switchback/protocol';
import { render } from 'ink-testing-library';
import { App } from './App.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PromptInput } from './PromptInput.tsx';
import { RewindPicker } from './RewindPicker.tsx';
import { filterSessions, SessionPicker } from './SessionPicker.tsx';
import { frameWith, session, tick } from './test-support.ts';

const CTRL_C = '\x03';
const ENTER = '\r';
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
        custom={[]}
        onSubmit={() => {}}
        onInterrupt={() => interrupts++}
        onSubmitNow={() => {}}
        onCancel={() => {}}
        recall={() => undefined}
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

describe('custom commands', () => {
  test('appear in the menu, and Enter waits for their argument', async () => {
    const got: string[] = [];
    const ui = render(
      <PromptInput
        focus
        busy={false}
        placeholder="Ask"
        history={[]}
        root="/tmp"
        custom={customCommands([
          { name: 'fix-issue', args: '<n>', description: 'Fix an issue', source: 'project' },
          { name: 'help', description: 'shadowed by the built-in', source: 'user' },
        ])}
        onSubmit={(t) => got.push(t)}
        onInterrupt={() => {}}
        onSubmitNow={() => {}}
        onCancel={() => {}}
        recall={() => undefined}
      />,
    );
    ui.stdin.write('/fix');
    await tick();
    expect(ui.lastFrame()).toContain('/fix-issue');
    expect(ui.lastFrame()).toContain('Fix an issue (project)');
    ui.stdin.write(ENTER);
    await tick();
    ui.stdin.write('12');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    expect(got).toEqual(['/fix-issue 12']);
  });
});

describe('command menu', () => {
  const menu = () =>
    render(
      <PromptInput
        focus
        busy={false}
        placeholder="Ask"
        history={[]}
        root="/tmp"
        custom={[]}
        onSubmit={() => {}}
        onInterrupt={() => {}}
        onSubmitNow={() => {}}
        onCancel={() => {}}
        recall={() => undefined}
      />,
    );

  test('shows a short usage whole, and the selected long one in full below', async () => {
    const tab = menu();
    tab.stdin.write('/tab');
    await tick();
    expect(tab.lastFrame()).toContain('/tab [n|new [agent]|close]');
    const effort = menu();
    effort.stdin.write('/eff');
    await tick();
    const lines = effort.lastFrame()?.split('\n') ?? [];
    expect(lines.some((l) => l.includes('/effort [none|low|') && l.includes('…'))).toBe(true);
    expect(lines).toContain('  /effort [none|low|medium|high|xhigh|max|default]');
  });
});

describe('during a turn', () => {
  test('Enter queues, Esc sends now, Esc on an empty prompt cancels, ↑ recalls', async () => {
    const got: string[] = [];
    const ui = render(
      <PromptInput
        focus
        busy
        placeholder="Queue"
        history={[]}
        root="/tmp"
        custom={[]}
        onSubmit={(t) => got.push(`queue:${t}`)}
        onInterrupt={() => {}}
        onSubmitNow={(t) => got.push(`now:${t}`)}
        onCancel={() => got.push('cancel')}
        recall={() => 'taken back'}
      />,
    );
    ui.stdin.write('later');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    ui.stdin.write('right now');
    await tick();
    ui.stdin.write('\x1b');
    await tick();
    ui.stdin.write('\x1b');
    await tick();
    ui.stdin.write('\x1b[A');
    await tick();
    expect(got).toEqual(['queue:later', 'now:right now', 'cancel']);
    expect(ui.lastFrame()).toContain('taken back');
  });
});

describe('newlines', () => {
  test('ctrl+j adds one, as a bare newline or in kitty keyboard protocol form', async () => {
    const got: string[] = [];
    const ui = render(
      <PromptInput
        focus
        busy={false}
        placeholder="Ask"
        history={[]}
        root="/tmp"
        custom={[]}
        onSubmit={(t) => got.push(t)}
        onInterrupt={() => {}}
        onSubmitNow={() => {}}
        onCancel={() => {}}
        recall={() => undefined}
      />,
    );
    for (const key of ['a', '\n', 'b', '\x1b[106;5u', 'c', ENTER]) {
      ui.stdin.write(key);
      await tick();
    }
    expect(got).toEqual(['a\nb\nc']);
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
        if (method === 'commands.list') return [];
        if (method === 'mcp.list') return { servers: [] };
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

describe('the current model and tabs in the app', () => {
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
        if (method === 'session.setRoles')
          return { ...roles, ...(params as object), overridden: ['current'] };
        if (method === 'session.create') return session(`new${++created}`, '');
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

  test('/current with no model opens a picker; the pick becomes current, backed by the old one', async () => {
    const { ui, calls } = app();
    await tick();
    expect(ui.lastFrame()).toContain('⌂ qwen3');
    ui.stdin.write('/current');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    expect(ui.lastFrame()).toContain('Current model');
    expect(ui.lastFrame()).toContain('● current');
    ui.stdin.write('2');
    await tick();
    await tick();
    expect(calls.find((c) => c.method === 'session.setRoles')?.params).toMatchObject({
      current: ['opus', 'fast'],
    });
    expect(await frameWith(ui, 'Current model: opus.')).toContain('Current model: opus.');
  });

  test('ctrl+t shows the sessions; n opens a new tab, and the tab bar appears', async () => {
    const { ui, calls } = app();
    await tick();
    ui.stdin.write('\x14');
    await tick();
    expect(ui.lastFrame()).toContain('Sessions');
    expect(ui.lastFrame()).toContain('fix the parser');
    ui.stdin.write('n');
    await tick();
    expect(calls.some((c) => c.method === 'session.create')).toBe(true);
    expect(ui.lastFrame()).toContain('1 fix the parser');
    expect(ui.lastFrame()).toContain('2 new session');
    // alt+1 goes back to the first tab.
    ui.stdin.write('\x1b1');
    await tick();
    ui.stdin.write('/tab');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    expect(await frameWith(ui, /› +1 · fix the parser .*here/)).toMatch(/› +1 · fix the parser/);
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

describe('rewind picker', () => {
  test('choose a checkpoint, then what to put back', async () => {
    const chosen: string[] = [];
    const ui = render(
      <RewindPicker
        checkpoints={[
          {
            turnId: 't1',
            index: 0,
            at: '2026-10-06T00:00:00Z',
            prompt: 'add a parser',
            files: ['a.ts'],
          },
          {
            turnId: 't2',
            index: 4,
            at: '2026-10-06T00:01:00Z',
            prompt: 'fix the bug',
            files: ['a.ts', 'b.ts'],
          },
        ]}
        onRewind={(turnId, restore) => chosen.push(`${turnId}:${restore}`)}
        onCancel={() => {}}
      />,
    );
    expect(ui.lastFrame()).toContain('fix the bug');
    ui.stdin.write('\x1b[B');
    await tick();
    ui.stdin.write(ENTER);
    await tick();
    expect(ui.lastFrame()).toContain('2 file(s) changed since then');
    ui.stdin.write('f');
    await tick();
    expect(chosen).toEqual(['t1:files']);
  });
});

test('the model picker lines up models whose aliases differ in length', () => {
  const choice = (alias: string, tier: 'local' | 'remote') => ({
    alias,
    model: `${alias}-model`,
    tier,
    roles: [],
    current: false,
    listed: false,
  });
  const ui = render(
    <ModelPicker
      choices={[choice('local', 'local'), choice('remote', 'remote')]}
      onPick={() => {}}
      onCancel={() => {}}
      onCommand={() => {}}
    />,
  );
  const frame = ui.lastFrame() ?? '';
  expect(frame).toContain('1. local   local-model · local');
  expect(frame).toContain('2. remote  remote-model · remote');
});
