import { describe, expect, test } from 'bun:test';
import type { SwitchbackClient } from '@switchback/client';
import type { EngineEvent, InitializeResult } from '@switchback/protocol';
import { render } from 'ink-testing-library';
import { App } from './App.tsx';
import { frameWith, session, tick } from './test-support.ts';

const ENTER = '\r';
const TAB = '\t';
const ESC = '\x1b';

const agents = [
  { name: 'build', description: 'writes code', source: 'builtin', mode: 'primary', route: 'auto' },
  {
    name: 'explore',
    description: 'reads code',
    source: 'builtin',
    mode: 'subagent',
    route: 'auto',
  },
  { name: 'docs', description: 'writes docs', source: 'project', mode: 'all', route: 'auto' },
] as const;

const init = {
  protocolVersion: 2,
  engineVersion: '0',
  workspaceRoot: '/tmp',
  models: [
    { alias: 'fast', ref: { provider: 'ollama', model: 'qwen3' }, tier: 'local' },
    { alias: 'opus', ref: { provider: 'anthropic', model: 'claude-opus-5' }, tier: 'remote' },
  ],
  agents: [...agents],
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
  const client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'permissions.list') return { modes: ['default'], levels: {}, rules: [] };
      if (method === 'usage.get') throw new Error('not needed');
      if (method === 'session.list') return [];
      if (method === 'commands.list') return [];
      if (method === 'mcp.list') return { servers: [] };
      if (method === 'agents.list') return agents;
      if (method === 'session.roles') return roles;
      if (method === 'session.setRoles') return { ...roles, ...(params as object) };
      if (method === 'session.setEffort') return { effort: (params as { effort: string }).effort };
      if (method === 'session.create') return session('s2', '', 'docs');
      return {};
    },
    on: (l: (e: EngineEvent) => void) => {
      listener = l;
      return () => {};
    },
  } as unknown as SwitchbackClient;
  const ui = render(
    <App
      client={client}
      init={init}
      initialSession={session('s1', 'fix the parser')}
      initialRoute="auto"
      warnings={[]}
    />,
  );
  const sent = (method: string) => calls.filter((c) => c.method === method).map((c) => c.params);
  return { ui, sent, emit: (e: EngineEvent) => listener?.(e) };
}

/** Type a command and run it. */
async function run(ui: ReturnType<typeof app>['ui'], text: string) {
  ui.stdin.write(text);
  await tick();
  ui.stdin.write(ENTER);
  await tick();
}

describe('Tab in a slash command', () => {
  test('completes a model name instead of switching the model', async () => {
    const { ui, sent } = app();
    await tick();
    ui.stdin.write('/current op');
    await tick();
    ui.stdin.write(TAB);
    await tick();
    expect(ui.lastFrame()).toContain('/current opus');
    expect(sent('session.setRoles')).toEqual([]);
    ui.stdin.write(ENTER);
    await tick();
    expect(sent('session.setRoles')).toEqual([{ sessionId: 's1', current: ['opus'], save: false }]);
  });

  test('with the command menu closed, or nothing to complete, does nothing', async () => {
    const { ui, sent } = app();
    await tick();
    ui.stdin.write('/cur');
    await tick();
    ui.stdin.write(ESC);
    await tick();
    ui.stdin.write(TAB);
    await tick();
    ui.stdin.write(' ');
    await tick();
    ui.stdin.write('x');
    await tick();
    ui.stdin.write(TAB);
    await tick();
    expect(ui.lastFrame()).toContain('/cur x');
    expect(sent('session.setRoles')).toEqual([]);
  });

  test('lists the matches when there are several, and goes round them', async () => {
    const { ui } = app();
    await tick();
    ui.stdin.write('/theme ');
    await tick();
    ui.stdin.write(TAB);
    expect(await frameWith(ui, 'tab for the next')).toContain('dark  light  plain');
    expect(ui.lastFrame()).toContain('/theme dark');
    ui.stdin.write(TAB);
    expect(await frameWith(ui, '/theme light')).toContain('/theme light');
  });
});

describe('commands with no argument open a picker', () => {
  test('/theme lists the themes on the one in use; a pick switches', async () => {
    const { ui } = app();
    await tick();
    await run(ui, '/theme');
    expect(ui.lastFrame()).toContain('Theme');
    expect(ui.lastFrame()).toMatch(/› 1\. dark +● now/);
    ui.stdin.write('2');
    expect(await frameWith(ui, 'theme: light')).toContain('theme: light');
  });

  test('/effort lists the levels and default; a pick sets the effort', async () => {
    const { ui, sent } = app();
    await tick();
    await run(ui, '/effort');
    expect(ui.lastFrame()).toContain("How hard this session's models reason");
    expect(ui.lastFrame()).toMatch(/default +follow the agent and each model ● now/);
    ui.stdin.write('\x1b[A');
    await tick();
    expect(ui.lastFrame()).toMatch(/› 6\. max/);
    ui.stdin.write('3');
    await tick();
    expect(sent('session.setEffort')).toEqual([{ sessionId: 's1', effort: 'medium' }]);
  });

  test('/agent lists the agents that run sessions; a pick starts one', async () => {
    const { ui, sent } = app();
    await tick();
    await run(ui, '/agent');
    const frame = await frameWith(ui, 'writes docs');
    expect(frame).toMatch(/build +writes code ● now/);
    expect(frame).not.toContain('explore');
    ui.stdin.write('2');
    await tick();
    expect(sent('session.create')).toEqual([{ agent: 'docs' }]);
  });

  test('/subagent-model opens the subagent model picker', async () => {
    const { ui, sent } = app();
    await tick();
    await run(ui, '/subagent-model');
    expect(ui.lastFrame()).toContain('Subagent model');
    ui.stdin.write('2');
    await tick();
    expect(sent('session.setRoles')).toEqual([{ sessionId: 's1', subagents: 'opus' }]);
  });

  test('/review lists on, off, default, and ladder', async () => {
    const { ui } = app();
    await tick();
    await run(ui, '/review');
    expect(ui.lastFrame()).toContain('Review of edits');
    ui.stdin.write('2');
    expect(await frameWith(ui, 'review: off')).toContain('review: off');
  });

  test('/subagent lists the subagents, or says there are none', async () => {
    const { ui, emit } = app();
    await tick();
    await run(ui, '/subagent');
    expect(await frameWith(ui, 'no subagents')).toContain('no subagents in this session yet');
    emit({ type: 'turn.started', sessionId: 's1', turnId: 't' });
    emit({
      type: 'subagent.started',
      sessionId: 's1',
      childSessionId: 'c1',
      agent: 'explore',
      task: 'find the parser',
    });
    await tick();
    await run(ui, '/subagent');
    expect(await frameWith(ui, 'Subagent')).toContain('1. explore: find the parser');
    ui.stdin.write(ENTER);
    expect(await frameWith(ui, '── explore: find the parser ──')).toContain(
      '── explore: find the parser ──',
    );
  });

  test('Esc closes a picker without running anything', async () => {
    const { ui, sent } = app();
    await tick();
    await run(ui, '/effort');
    ui.stdin.write(ESC);
    await tick();
    expect(ui.lastFrame()).not.toContain("How hard this session's models reason");
    expect(sent('session.setEffort')).toEqual([]);
  });
});
