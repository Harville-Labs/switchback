import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

test('escalating now sends the next prompt one step up, then stays there a while', async () => {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
      remote: { provider: 'rp', model: 'big', contextWindow: 200_000 },
    },
    // `ask` would prompt for an automatic escalation; the user's own doesn't.
    routing: { start: ['local'], escalate: [['remote']], escalation: { policy: 'ask' } },
  });
  const lp = new ScriptedProvider('lp', 'local', [{ text: 'local' }]);
  const rp = new ScriptedProvider('rp', 'remote', [{ text: 'remote' }, { text: 'remote again' }]);
  const engine = new Engine({
    workspaceRoot: '/tmp',
    config,
    providers: new Map([
      ['lp', lp],
      ['rp', rp],
    ]),
  });
  const routes: EngineEvent[] = [];
  engine.subscribe((e) => e.type === 'route.decided' && routes.push(e));
  const s = engine.createSession({});
  expect(engine.escalate(s.id)).toEqual({ when: 'next-prompt' });
  await engine.runTurn(s.id, 'this is hard');
  expect(routes[0]).toMatchObject({ rule: 'user-escalation', model: { model: 'big' } });
  // The request is used up; stickiness keeps the next turn on the same step.
  await engine.runTurn(s.id, 'and this');
  expect(routes[1]).toMatchObject({ rule: 'sticky', model: { model: 'big' } });
  expect(lp.requests).toHaveLength(0);
});
