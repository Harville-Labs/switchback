import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineEvent, textOf } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-queue-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(script: Script) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
    routing: { start: ['local'] },
    permissions: { bash: 'ask' },
  });
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({ workspaceRoot: root, config, providers: new Map([['lp', lp]]) });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const next = (type: EngineEvent['type'], n = 1) =>
    new Promise<EngineEvent>((resolve) => {
      let seen = 0;
      const off = engine.subscribe((e) => {
        if (e.type === type && ++seen === n) {
          off();
          resolve(e);
        }
      });
    });
  return { engine, lp, events, next };
}

/** The user text the model saw last on request `i`. */
const lastUserText = (lp: ScriptedProvider, i: number) => {
  const m = lp.requests[i]?.messages.findLast((m) => m.role === 'user');
  return m ? textOf(m) : '';
};

const askFirst = { toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] };

describe('queued prompts', () => {
  test('reach the model at the next step of the running turn', async () => {
    const { engine, lp, events, next } = setup([askFirst, { text: 'did both' }]);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'run it' });
    const ask = (await next('permission.requested')) as Extract<
      EngineEvent,
      { type: 'permission.requested' }
    >;
    const r = engine.prompt({ sessionId: s.id, text: 'and then say done' });
    expect(r.queued).toBeDefined();
    expect(events.findLast((e) => e.type === 'queue.updated')).toMatchObject({
      queued: [{ text: 'and then say done' }],
    });
    engine.respondPermission(ask.requestId, 'allow_once');
    await next('turn.completed');
    expect(lastUserText(lp, 1)).toBe('and then say done');
    expect(events.find((e) => e.type === 'queue.delivered')).toMatchObject({
      turnId: r.turnId,
      prompt: { text: 'and then say done' },
    });
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
  });

  test("sent during the model's last step, they start the next turn", async () => {
    let engineRef: Engine | undefined;
    let sessionId = '';
    const { engine, lp, next } = setup((_req, turn) => {
      if (turn === 0) engineRef?.prompt({ sessionId, text: 'one more thing' });
      return { text: turn === 0 ? 'first answer' : 'second answer' };
    });
    engineRef = engine;
    sessionId = engine.createSession({}).id;
    engine.prompt({ sessionId, text: 'hello' });
    await next('turn.completed', 2);
    expect(lp.requests).toHaveLength(2);
    expect(lastUserText(lp, 1)).toBe('one more thing');
  });

  test('can be withdrawn, and cancel drops them', async () => {
    const { engine, lp, next } = setup([askFirst, { text: 'ok' }]);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'run it' });
    await next('permission.requested');
    const a = engine.prompt({ sessionId: s.id, text: 'withdrawn' });
    engine.prompt({ sessionId: s.id, text: 'cancelled' });
    expect(engine.dequeue(s.id, a.queued as string)).toEqual({ removed: true });
    expect(engine.dequeue(s.id, a.queued as string)).toEqual({ removed: false });
    engine.cancel(s.id);
    await next('turn.completed');
    await Bun.sleep(20);
    expect(lp.requests).toHaveLength(1);
  });
});

describe('interrupt', () => {
  test('stops the running turn and starts the new prompt at once', async () => {
    const { engine, lp, events, next } = setup([askFirst, { text: 'new direction' }]);
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'run it' });
    await next('permission.requested');
    const r = engine.prompt({
      sessionId: s.id,
      text: 'stop, do this instead',
      delivery: 'interrupt',
    });
    expect(r.queued).toBeUndefined();
    await next('turn.completed', 2);
    const completed = events.filter((e) => e.type === 'turn.completed');
    expect(completed.map((e) => e.type === 'turn.completed' && e.stopReason)).toEqual([
      'cancelled',
      'end_turn',
    ]);
    expect(completed[1]).toMatchObject({ turnId: r.turnId });
    expect(lastUserText(lp, 1)).toBe('stop, do this instead');
  });
});
