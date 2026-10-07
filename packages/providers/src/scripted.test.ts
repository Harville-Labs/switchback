import { expect, test } from 'bun:test';
import type { ChatEvent, ChatRequest } from './index.ts';
import { ScriptedProvider } from './scripted.ts';

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
