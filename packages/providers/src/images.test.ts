import { expect, test } from 'bun:test';
import type { ImagePart, Message } from '@switchback/protocol';
import { toAnthropicMessages } from './anthropic.ts';
import { toGeminiContents } from './gemini.ts';
import { toWireMessages } from './openai-chat-messages.ts';
import { toResponsesInput } from './openai-responses.ts';

const shot: ImagePart = {
  type: 'image',
  mediaType: 'image/png',
  data: 'iVBORw0K',
  attachment: { path: 'shot.png' },
};
const logo: ImagePart = { type: 'image', mediaType: 'image/webp', data: 'UklGRg==' };
const origin = { provider: 'p', model: 'm' };

/** The user's own image, then a read that returned one. */
const HISTORY: Message[] = [
  { role: 'user', parts: [{ type: 'text', text: 'what is wrong here?' }, shot] },
  {
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'c1', name: 'read', input: { path: 'logo.webp' } }],
  },
  {
    role: 'user',
    parts: [
      { type: 'tool_result', callId: 'c1', content: 'logo.webp: WEBP image', images: [logo] },
    ],
  },
];

test('Anthropic: image blocks, and images inside the tool result', () => {
  const [first, , third] = toAnthropicMessages('p', 'm', HISTORY);
  expect(first?.content).toEqual([
    { type: 'text', text: 'what is wrong here?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
  ]);
  expect(third?.content).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 'c1',
      content: [
        { type: 'text', text: 'logo.webp: WEBP image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRg==' } },
      ],
    },
  ]);
});

test('Chat Completions: data URLs; a tool image follows the tool message as user content', () => {
  const wire = toWireMessages('', HISTORY);
  expect(wire[0]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'what is wrong here?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
    ],
  });
  expect(wire.slice(2)).toEqual([
    { role: 'tool', tool_call_id: 'c1', content: 'logo.webp: WEBP image' },
    {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==' } }],
    },
  ]);
  // Without images, text stays a plain string.
  expect(toWireMessages('', [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }])).toEqual([
    { role: 'user', content: 'hi' },
  ]);
});

test('Responses: input_image items', () => {
  const items = toResponsesInput(HISTORY, origin);
  expect(items[0]).toEqual({
    role: 'user',
    content: [
      { type: 'input_text', text: 'what is wrong here?' },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0K', detail: 'auto' },
    ],
  });
  expect(items.at(-1)).toEqual({
    role: 'user',
    content: [
      { type: 'input_image', image_url: 'data:image/webp;base64,UklGRg==', detail: 'auto' },
    ],
  });
});

test('Gemini: inline data, after the function response for a tool image', () => {
  const contents = toGeminiContents(HISTORY, origin);
  expect(contents[0]?.parts).toEqual([
    { text: 'what is wrong here?' },
    { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } },
  ]);
  expect(contents[2]?.parts?.[1]).toEqual({
    inlineData: { mimeType: 'image/webp', data: 'UklGRg==' },
  });
});
