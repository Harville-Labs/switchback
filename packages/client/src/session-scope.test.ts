import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { SessionScope } from './session-scope.ts';
import { initialView, reduce } from './view.ts';

const ask = (sessionId: string, parentSessionId?: string): EngineEvent => ({
  type: 'permission.requested',
  sessionId,
  ...(parentSessionId ? { parentSessionId } : {}),
  requestId: `p-${sessionId}`,
  tool: 'bash',
  summary: 'rm -rf build',
  input: {},
});

describe('SessionScope', () => {
  test("another window's session isn't in scope; this window's is", () => {
    const scope = new SessionScope();
    scope.add('mine');
    expect(scope.observe(ask('theirs'))).toBe(false);
    expect(scope.observe(ask('mine'))).toBe(true);
  });

  test('subagents and their subagents belong to the session that started them', () => {
    const scope = new SessionScope();
    scope.add('mine');
    scope.observe({
      type: 'subagent.started',
      sessionId: 'mine',
      childSessionId: 'kid',
      agent: 'explore',
      task: 'look',
    });
    expect(scope.observe(ask('kid', 'mine'))).toBe(true);
    expect(scope.observe(ask('grandkid', 'kid'))).toBe(true);
    expect(scope.observe(ask('stranger', 'theirs'))).toBe(false);
  });

  test('events about no session belong to every client', () => {
    expect(new SessionScope().observe({ type: 'log', level: 'info', message: 'hi' })).toBe(true);
  });
});

describe('prompts in a view', () => {
  test("a permission prompt from a session outside the view isn't shown", () => {
    const view = reduce(initialView('mine'), ask('theirs'));
    expect(view.permissions).toEqual([]);
  });

  test("an escalation from a session outside the view isn't shown", () => {
    const view = reduce(initialView('mine'), {
      type: 'escalation.requested',
      sessionId: 'theirs',
      requestId: 'e1',
      reason: 'stuck',
      target: { provider: 'p', model: 'm' },
    });
    expect(view.escalations).toEqual([]);
  });

  test("the view's own and its subagents' prompts are shown", () => {
    let view = reduce(initialView('mine'), ask('mine'));
    view = reduce(view, ask('kid', 'mine'));
    expect(view.permissions.map((p) => p.sessionId)).toEqual(['mine', 'kid']);
  });
});
