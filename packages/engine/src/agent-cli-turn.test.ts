import { expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
    routing: { current: [start], escalate: [['cc']] },
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

/** Stands in for a CLI that uses Switchback's tools over MCP, the way Claude Code or Codex would. */
function toolUsingCli(seen: {
  names: string[];
  outputs: string[];
  task?: RuntimeTask;
}): AgentRuntime {
  return {
    label: 'Claude Code',
    async run(task) {
      // The subagent runs on this CLI too; it just answers.
      if (seen.task) return { ok: true, text: 'in parse.ts', calls: [] };
      seen.task = task;
      const tools = task.tools;
      if (!tools) throw new Error('no Switchback tools');
      const client = new Client({ name: 'cli', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(tools.url), {
          requestInit: { headers: tools.headers },
        }),
      );
      seen.names = (await client.listTools()).tools.map((t) => t.name);
      for (const [name, args] of [
        ['docs', {}],
        ['task', { agent: 'explore', description: 'find parse', prompt: 'Where is parse?' }],
      ] as const) {
        const r = (await client.callTool({ name, arguments: args })) as {
          content: { text: string }[];
        };
        seen.outputs.push(r.content[0]?.text ?? '');
      }
      await client.close();
      return { ok: true, text: 'delegated', calls: [] };
    },
  };
}

test("a CLI model gets Switchback's instructions and tools, and its subagents are Switchback's", async () => {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' }, claude: { type: 'claude-code' } },
    models: {
      local: { provider: 'lp', model: 'small', contextWindow: 32_000 },
      cc: { provider: 'claude', model: 'sonnet', contextWindow: 200_000 },
    },
    routing: { current: ['cc'], escalate: [['cc']] },
  });
  const seen: { names: string[]; outputs: string[]; task?: RuntimeTask } = {
    names: [],
    outputs: [],
  };
  const engine = new Engine({
    workspaceRoot: '/tmp',
    config,
    providers: new Map([['lp', new ScriptedProvider('lp', 'local', [])]]),
    runtimes: new Map([['cc', toolUsingCli(seen)]]),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const s = engine.createSession({});
  await engine.runTurn(s.id, 'use a subagent to find parse');

  expect(seen.task?.instructions).toContain('# Working in Switchback');
  expect(seen.names.sort()).toEqual(['docs', 'escalate', 'merge_worktree', 'skill', 'task']);
  expect(seen.outputs[0]).toContain('configuration');
  expect(seen.outputs[1]).toBe('in parse.ts');
  // The subagent ran as Switchback's own, so the clients show it in its tab.
  expect(events.some((e) => e.type === 'subagent.started')).toBe(true);
  expect(events.find((e) => e.type === 'tool.started' && e.name === 'task')).toMatchObject({
    sessionId: s.id,
  });
});

test("the tool server turns away requests without the turn's token", async () => {
  const { serveTools } = await import('./tool-server.ts');
  const server = serveTools([], async () => ({ content: '' }));
  try {
    const r = await fetch(server.url, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  } finally {
    server.close();
  }
});
