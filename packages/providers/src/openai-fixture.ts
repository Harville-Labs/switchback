import type { Message } from '@switchback/protocol';
import type { OpenAICompatibleProvider } from './openai-compatible.ts';
import type { ChatEvent, ChatRequest } from './types.ts';

/** Captures the request body and answers with a fixed SSE stream. */
export function capture(chunks: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchStub = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(sse);
  }) as unknown as typeof fetch;
  return { bodies, fetchStub };
}

export async function drain(p: OpenAICompatibleProvider, req: Partial<ChatRequest>) {
  const events: ChatEvent[] = [];
  for await (const e of p.stream({
    model: 'm',
    system: 's',
    messages: [],
    tools: [],
    maxTokens: 100,
    ...req,
  }))
    events.push(e);
  return events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
}

export const history = (origin: { provider: string; model: string }): Message[] => [
  { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  {
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'thinking...', origin },
      { type: 'tool_call', id: 'c1', name: 'read', input: { path: 'a' } },
    ],
  },
  { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: 'A' }] },
];
