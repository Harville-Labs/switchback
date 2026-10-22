import { expect, test } from 'bun:test';
import type { ChatEvent, ChatRequest } from './index.ts';
import { prefixCache, ScriptedProvider } from './scripted.ts';

const request: ChatRequest = { model: 'demo', system: '', messages: [], tools: [], maxTokens: 100 };

async function collect(provider: ScriptedProvider): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const e of provider.stream(request)) events.push(e);
  return events;
}

test('scripted reasoning streams before the text and is kept with the model that produced it', async () => {
  const events = await collect(
    new ScriptedProvider('p', 'local', [{ reasoning: 'Check first.', text: 'Done.' }]),
  );
  expect(events.map((e) => e.type)).toEqual([
    'reasoning.delta',
    'reasoning.delta',
    'text.delta',
    'done',
  ]);
  const done = events.at(-1);
  expect(done?.type === 'done' && done.parts).toEqual([
    { type: 'reasoning', text: 'Check first.', origin: { provider: 'p', model: 'demo' } },
    { type: 'text', text: 'Done.' },
  ]);
});

test('the mock prefix cache reads what a request shares with the session’s previous one', () => {
  const usage = prefixCache();
  const first: ChatRequest = {
    ...request,
    system: 'x'.repeat(4000),
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    cacheKey: 'a',
  };
  expect(usage(first).cacheReadTokens).toBe(0);
  const next: ChatRequest = {
    ...first,
    messages: [...first.messages, { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] }],
  };
  const hit = usage(next);
  expect(hit.cacheReadTokens).toBeGreaterThan(1000);
  expect(hit.inputTokens).toBeLessThan(20);
  // Another session starts cold; a changed system prompt misses.
  expect(usage({ ...next, cacheKey: 'b' }).cacheReadTokens).toBe(0);
  expect(usage({ ...next, system: 'y' }).cacheReadTokens).toBe(0);
});
