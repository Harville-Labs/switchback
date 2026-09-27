import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider, type MessagesClient } from './anthropic.ts';
import type { ChatEvent } from './types.ts';

interface FakeMessage {
  model: string;
  content: Record<string, unknown>[];
  stop_reason: string;
  usage: Record<string, unknown>;
}

/** A client whose stream() replays deltas and resolves to a fixed final message. */
function fakeClient(respond: (params: Record<string, unknown>) => FakeMessage | Error) {
  const calls: { beta: boolean; params: Record<string, unknown> }[] = [];
  const stream = (beta: boolean) => (params: Record<string, unknown>) => {
    calls.push({ beta, params });
    const result = respond(params);
    return {
      async *[Symbol.asyncIterator]() {
        if (result instanceof Error) throw result;
        for (const b of result.content)
          if (b.type === 'text')
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: b.text } };
      },
      finalMessage: async () => result,
    };
  };
  const client = {
    messages: { stream: stream(false) },
    beta: { messages: { stream: stream(true) } },
  } as unknown as MessagesClient;
  return { client, calls };
}

const usage = { input_tokens: 100, output_tokens: 20 };

async function run(p: AnthropicProvider, model = 'claude-opus-5') {
  const events: ChatEvent[] = [];
  for await (const e of p.stream({ model, system: 's', messages: [], tools: [], maxTokens: 64 }))
    events.push(e);
  return events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
}

function provider(
  client: MessagesClient,
  kind: 'anthropic' | 'bedrock' | 'aws' | 'foundry' = 'anthropic',
) {
  const platform =
    kind === 'anthropic'
      ? ({ kind } as const)
      : kind === 'bedrock'
        ? ({ kind, region: 'us-east-1' } as const)
        : kind === 'aws'
          ? ({ kind, region: 'us-east-1', workspaceId: 'wrkspc_1' } as const)
          : ({ kind, resource: 'acme', apiKey: 'k' } as const);
  return new AnthropicProvider({
    id: kind,
    tier: 'remote',
    platform,
    serverFallback: true,
    client,
  });
}

describe('server-side refusal fallback (first-party API)', () => {
  test('sends fallbacks: "default" under its beta header', async () => {
    const { client, calls } = fakeClient(() => ({
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage,
    }));
    const done = await run(provider(client));
    expect(calls[0]).toMatchObject({
      beta: true,
      params: { fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] },
    });
    expect(done.model).toBeUndefined();
  });

  test('mid-stream fallback: keeps text, drops the decliner’s thinking and tool calls, reports the model', async () => {
    const { client } = fakeClient(() => ({
      model: 'claude-opus-4-8',
      content: [
        { type: 'thinking', thinking: 'declined model', signature: 'sig-a' },
        { type: 'text', text: 'partial ' },
        { type: 'tool_use', id: 't0', name: 'read', input: {} },
        { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'thinking', thinking: 'fallback model', signature: 'sig-b' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'x' } },
      ],
      stop_reason: 'tool_use',
      usage: { ...usage, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
    }));
    const done = await run(provider(client));
    expect(done.model).toBe('claude-opus-4-8');
    expect(done.parts).toEqual([
      { type: 'text', text: 'partial ' },
      {
        type: 'reasoning',
        text: 'fallback model',
        origin: { provider: 'anthropic', model: 'claude-opus-4-8' },
        opaque: { signature: 'sig-b' },
      },
      { type: 'text', text: 'answer' },
      { type: 'tool_call', id: 't1', name: 'grep', input: { pattern: 'x' } },
    ]);
  });

  test('sticky-served turns are recognised from usage.iterations alone', async () => {
    const { client } = fakeClient(() => ({
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'still the fallback' }],
      stop_reason: 'end_turn',
      usage: { ...usage, iterations: [{ type: 'fallback_message' }] },
    }));
    expect((await run(provider(client))).model).toBe('claude-opus-4-8');
  });

  test('a whole-chain refusal is returned as a refusal', async () => {
    const { client } = fakeClient(() => ({
      model: 'claude-opus-4-8',
      content: [
        { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
      ],
      stop_reason: 'refusal',
      usage: { ...usage, iterations: [{ type: 'fallback_message' }] },
    }));
    const done = await run(provider(client));
    expect(done.stopReason).toBe('refusal');
    expect(done.model).toBeUndefined();
  });

  test('a model that rejects the parameter is retried once without it, then never sent it', async () => {
    const { client, calls } = fakeClient((params) =>
      params.fallbacks
        ? new Anthropic.BadRequestError(
            400,
            { error: { message: 'fallbacks is not supported for this model' } },
            'fallbacks is not supported for this model',
            new Headers(),
          )
        : {
            model: 'claude-haiku-4-5',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage,
          },
    );
    const p = provider(client);
    expect((await run(p, 'claude-haiku-4-5')).parts).toEqual([{ type: 'text', text: 'ok' }]);
    await run(p, 'claude-haiku-4-5');
    expect(calls.map((c) => c.beta)).toEqual([true, false, false]);
  });

  test('never sent on Bedrock or Vertex', async () => {
    const { client, calls } = fakeClient(() => ({
      model: 'anthropic.claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage,
    }));
    await run(provider(client, 'bedrock'), 'anthropic.claude-opus-5');
    expect(calls[0]?.beta).toBe(false);
    expect(calls[0]?.params).not.toHaveProperty('fallbacks');
  });
});

test('effort none sends no thinking and no effort', async () => {
  const { client, calls } = fakeClient(() => ({
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage,
  }));
  const p = new AnthropicProvider({
    id: 'a',
    tier: 'remote',
    platform: { kind: 'anthropic' },
    client,
  });
  for await (const _ of p.stream({
    model: 'claude-opus-5',
    system: 's',
    messages: [],
    tools: [],
    maxTokens: 64,
    effort: 'none',
  })) {
    // drain
  }
  expect(calls[0]?.params).not.toHaveProperty('thinking');
  expect(calls[0]?.params).not.toHaveProperty('output_config');
});

describe('Claude platforms', () => {
  const ok = () => ({
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage,
  });

  test('Claude Platform on AWS gets server-side fallbacks; Foundry does not', async () => {
    const aws = fakeClient(ok);
    await run(provider(aws.client, 'aws'));
    expect(aws.calls[0]).toMatchObject({ beta: true, params: { fallbacks: 'default' } });
    const foundry = fakeClient(ok);
    await run(provider(foundry.client, 'foundry'));
    expect(foundry.calls[0]?.beta).toBe(false);
  });

  test('health names the missing setting', async () => {
    const saved = { ...process.env };
    delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;
    delete process.env.ANTHROPIC_FOUNDRY_API_KEY;
    delete process.env.ANTHROPIC_FOUNDRY_RESOURCE;
    delete process.env.ANTHROPIC_FOUNDRY_BASE_URL;
    try {
      const aws = new AnthropicProvider({
        id: 'a',
        tier: 'remote',
        platform: { kind: 'aws', region: 'us-east-1' },
      });
      expect((await aws.health()).detail).toContain('ANTHROPIC_AWS_WORKSPACE_ID');
      const foundry = new AnthropicProvider({
        id: 'f',
        tier: 'remote',
        platform: { kind: 'foundry', resource: 'acme' },
      });
      expect((await foundry.health()).detail).toContain('ANTHROPIC_FOUNDRY_API_KEY');
      const ready = new AnthropicProvider({
        id: 'f',
        tier: 'remote',
        platform: { kind: 'foundry', resource: 'acme', apiKey: 'k' },
      });
      expect((await ready.health()).ok).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
