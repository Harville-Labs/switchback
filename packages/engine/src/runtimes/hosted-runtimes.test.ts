import { describe, expect, test } from 'bun:test';
import type { ThreadEvent } from '@openai/codex-sdk';
import { AgentCoreRuntime, answerOf } from './bedrock-agentcore.ts';
import { type ManagedAgentsClient, ManagedAgentsRuntime } from './claude-managed-agents.ts';
import { CodexRuntime } from './codex.ts';
import type { RuntimeEvent, RuntimeTask } from './runtime.ts';

function task(allow: boolean) {
  const events: RuntimeEvent[] = [];
  const asked: string[] = [];
  const t: RuntimeTask = {
    prompt: 'fix the bug',
    cwd: '/repo',
    signal: new AbortController().signal,
    canUseTool: async (name) => {
      asked.push(name);
      return allow ? { allowed: true } : { allowed: false, message: 'no' };
    },
    onEvent: (e) => events.push(e),
  };
  return { t, events, asked };
}

describe('Claude Managed Agents', () => {
  function fakeClient(sent: unknown[]): ManagedAgentsClient {
    const stream = async function* () {
      yield {
        type: 'agent.message',
        id: 'm1',
        content: [{ type: 'text', text: 'Running tests.' }],
      };
      yield {
        type: 'agent.tool_use',
        id: 'tu1',
        name: 'bash',
        input: { command: 'rm -rf /' },
        evaluated_permission: 'ask',
      };
      yield { type: 'session.status_idle', id: 'i1', stop_reason: { type: 'requires_action' } };
      yield {
        type: 'agent.tool_result',
        id: 'r1',
        tool_use_id: 'tu1',
        content: [{ type: 'text', text: 'denied' }],
        is_error: true,
      };
      yield {
        type: 'span.model_request_end',
        id: 's1',
        model_usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      yield {
        type: 'agent.message',
        id: 'm2',
        content: [{ type: 'text', text: 'Done without deleting.' }],
      };
      yield { type: 'session.status_idle', id: 'i2', stop_reason: { type: 'end_turn' } };
    };
    return {
      agents: { retrieve: async () => ({ model: { id: 'claude-sonnet-5' } }) },
      sessions: {
        create: async () => ({ id: 'sesn_1' }),
        events: {
          stream: async () => stream(),
          send: async (_id: string, body: unknown) => sent.push(body),
        },
      },
    } as unknown as ManagedAgentsClient;
  }

  test('asks the policy about ask-permission tools, streams, and prices usage', async () => {
    const sent: unknown[] = [];
    const runtime = new ManagedAgentsRuntime({
      name: 'cma',
      agent: 'agent_1',
      environment: 'env_1',
      client: fakeClient(sent),
    });
    const { t, events, asked } = task(false);
    const r = await runtime.run(t);
    expect(asked).toEqual(['bash']);
    expect(sent[1]).toEqual({
      events: [
        { type: 'user.tool_confirmation', tool_use_id: 'tu1', result: 'deny', deny_message: 'no' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Done without deleting.');
    expect(r.calls[0]?.model).toEqual({ provider: 'cma', model: 'claude-sonnet-5' });
    expect(r.calls[0]?.costUsd).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(['text', 'tool.started', 'tool.completed', 'text']);
  });
});

describe('Codex', () => {
  function fakeCodex(seen: unknown[], stream: ThreadEvent[]) {
    return {
      startThread: (options: unknown) => {
        seen.push(options);
        return {
          runStreamed: async () => ({
            events: (async function* () {
              yield* stream;
            })(),
          }),
        };
      },
    } as unknown as ConstructorParameters<typeof CodexRuntime>[0]['codex'];
  }
  const RUN: ThreadEvent[] = [
    {
      type: 'item.started',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'c1',
        type: 'command_execution',
        command: 'bun test',
        aggregated_output: '1 fail',
        exit_code: 1,
        status: 'failed',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'f1',
        type: 'file_change',
        changes: [{ path: 'a.ts', kind: 'update' }],
        status: 'completed',
      },
    },
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Fixed a.ts.' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 5000,
        cached_input_tokens: 4000,
        cache_write_input_tokens: 0,
        output_tokens: 300,
        reasoning_output_tokens: 0,
      },
    },
  ];

  test('one approval for the run, the sandbox it asked for, and its work as tool rows', async () => {
    const seen: unknown[] = [];
    const runtime = new CodexRuntime({
      name: 'codex',
      sandbox: 'workspace-write',
      network: false,
      model: 'gpt-6-sol',
      codex: fakeCodex(seen, RUN),
    });
    const { t, events, asked } = task(true);
    const r = await runtime.run(t);
    expect(asked).toEqual(['codex']);
    expect(seen[0]).toMatchObject({
      workingDirectory: '/repo',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      model: 'gpt-6-sol',
    });
    expect(r).toMatchObject({ ok: true, text: 'Fixed a.ts.' });
    expect(r.calls[0]?.usage).toMatchObject({
      inputTokens: 1000,
      cacheReadTokens: 4000,
      outputTokens: 300,
    });
    expect(
      events
        .filter((e) => e.type === 'tool.completed')
        .map((e) => [
          e.type === 'tool.completed' && e.name,
          e.type === 'tool.completed' && e.isError,
        ]),
    ).toEqual([
      ['bash', true],
      ['edit', false],
    ]);
  });

  test('a denied run never starts', async () => {
    const seen: unknown[] = [];
    const runtime = new CodexRuntime({
      name: 'codex',
      sandbox: 'read-only',
      network: false,
      codex: fakeCodex(seen, RUN),
    });
    const r = await runtime.run(task(false).t);
    expect(r).toEqual({ ok: false, text: 'no', calls: [] });
    expect(seen).toEqual([]);
  });
});

describe('Bedrock AgentCore', () => {
  const body = (text: string) => ({
    transformToWebStream: () => new Response(text).body as ReadableStream<Uint8Array>,
  });

  test('streams server-sent events and sends the prompt as JSON', async () => {
    const inputs: { payload: Uint8Array; runtimeSessionId: string }[] = [];
    const runtime = new AgentCoreRuntime({
      name: 'ac',
      arn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/x',
      invoke: async (input) => {
        inputs.push(input);
        return {
          contentType: 'text/event-stream',
          response: body('data: "Hello"\n\ndata: " there"\n\n') as never,
        };
      },
    });
    const { t, events } = task(true);
    const r = await runtime.run(t);
    expect(r).toEqual({ ok: true, text: 'Hello there', calls: [] });
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
    ]);
    expect(JSON.parse(new TextDecoder().decode(inputs[0]?.payload))).toEqual({
      prompt: 'fix the bug',
    });
    expect(inputs[0]?.runtimeSessionId.length).toBeGreaterThanOrEqual(33);
  });

  test('reads a JSON answer in the shapes agents use', () => {
    expect(answerOf('"plain"')).toBe('plain');
    expect(answerOf('{"result":"from result"}')).toBe('from result');
    expect(answerOf('not json')).toBe('not json');
    expect(answerOf('{"a":1}')).toBe('{"a":1}');
  });
});
