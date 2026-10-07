import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { handoffPrompt } from './agent-cli-turn.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import type { AgentRuntime, RuntimeTask } from './runtimes/runtime.ts';

/** Stands in for Claude Code: answers, reports usage, and hands back a session to resume. */
function fakeCli(tasks: RuntimeTask[]): AgentRuntime {
  return {
    label: 'Claude Code',
    async run(task) {
      tasks.push(task);
      task.onEvent({ type: 'tool.started', callId: 't1', name: 'Bash', input: { command: 'ls' } });
      task.onEvent({
        type: 'tool.completed',
        callId: 't1',
        name: 'Bash',
        output: 'a.ts',
        isError: false,
      });
      return {
        ok: true,
        text: `done #${tasks.length}`,
        sessionId: 'cc-session-1',
        calls: [
          {
            model: { provider: 'claude', model: 'claude-sonnet-5' },
            usage: { inputTokens: 1000, outputTokens: 100 },
            costUsd: 0.5,
          },
        ],
      };
    },
  };
}

function setup(start: string, billing: 'subscription' | 'api' = 'subscription') {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, claude: { type: 'claude-code', billing } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
      cc: { provider: 'claude', model: 'sonnet', contextWindow: 200_000 },
    },
    routing: { start: [start], escalate: [['cc']] },
  });
  const tasks: RuntimeTask[] = [];
  const lp = new ScriptedProvider('lp', 'local', [{ text: 'local answer' }]);
  const engine = new Engine({
    workspaceRoot: '/tmp',
    config,
    providers: new Map([['lp', lp]]),
    runtimes: new Map([['cc', fakeCli(tasks)]]),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, tasks, events };
}

test('a CLI model works the whole turn, resumes its session, and is free on a subscription', async () => {
  const { engine, tasks, events } = setup('cc');
  const s = engine.createSession({});
  await engine.runTurn(s.id, 'fix the build');
  expect(tasks[0]?.prompt).toBe('fix the build');
  expect(tasks[0]?.resume).toBeUndefined();
  expect(events.some((e) => e.type === 'tool.completed' && e.name === 'Bash')).toBe(true);
  expect(engine.getSession(s.id).messages.at(-1)).toMatchObject({
    role: 'assistant',
    parts: [{ type: 'text', text: 'done #1' }],
    meta: { model: { provider: 'claude', model: 'sonnet' } },
  });
  await engine.runTurn(s.id, 'now add a test');
  // Resumed, and told only the new prompt: it saw the rest itself.
  expect(tasks[1]).toMatchObject({ resume: 'cc-session-1', prompt: 'now add a test' });
  expect(engine.usage(undefined, s.id).byTier.remote.costUsd).toBe(0);
});

test('on an API key, the reported cost counts', async () => {
  const { engine } = setup('cc', 'api');
  const s = engine.createSession({});
  await engine.runTurn(s.id, 'go');
  expect(engine.usage(undefined, s.id).byTier.remote.costUsd).toBe(0.5);
});

test('taking over mid-conversation, the CLI gets a digest of what it missed', () => {
  const prompt = handoffPrompt(
    [
      { role: 'user', parts: [{ type: 'text', text: 'what does parse do?' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'It tokenizes.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'fix the quoting bug' }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c', name: 'bash', input: { command: 'bun test' } }],
      },
      {
        role: 'user',
        parts: [{ type: 'tool_result', callId: 'c', content: '1 fail', isError: true }],
      },
    ],
    0,
  );
  expect(prompt).toContain("Earlier in this conversation, which you haven't seen:");
  expect(prompt).toContain('It tokenizes.');
  expect(prompt).toContain('The request:\nfix the quoting bug');
  expect(prompt).toContain('Work done on it so far, before you took over:');
  expect(prompt).toContain('1 fail');
});
