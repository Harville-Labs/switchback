import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImagePart, Message } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { pastedImage, readImage, sniffImage, withoutImages } from './images.ts';
import { messageTokens } from './tokens.ts';
import { readTool } from './tools/fs.ts';
import type { ToolContext } from './tools/tool.ts';

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-img-'));
  writeFileSync(join(root, 'dot.png'), PNG);
  writeFileSync(join(root, 'fake.png'), 'not an image');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('images', () => {
  test('the bytes decide the format, whatever the name says', async () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(await readImage(join(root, 'fake.png'), 'fake.png')).toContain('not a PNG');
    expect(pastedImage('clip', PNG.toString('base64'))).toMatchObject({
      mediaType: 'image/png',
      attachment: { path: 'clip' },
    });
    expect(pastedImage('clip', Buffer.alloc(4_000_000).toString('base64'))).toContain('at most');
  });

  test('a model without vision reads a note in each image’s place', () => {
    const image: ImagePart = {
      type: 'image',
      mediaType: 'image/png',
      data: 'x',
      attachment: { path: 'a.png' },
    };
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'look' }, image] },
      {
        role: 'user',
        parts: [{ type: 'tool_result', callId: 'c', content: 'a.png: PNG image', images: [image] }],
      },
    ];
    const sent = withoutImages(messages);
    expect(sent[0]?.parts[1]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(sent)).toContain(
      "image a.png is attached, but this model can't see images",
    );
    expect(JSON.stringify(sent)).not.toContain('"images"');
    // The transcript itself is untouched.
    expect(messages[0]?.parts[1]).toBe(image);
  });

  test('an image counts as a fixed number of tokens, not its base64', () => {
    const big: ImagePart = { type: 'image', mediaType: 'image/png', data: 'A'.repeat(3_000_000) };
    expect(messageTokens({ role: 'user', parts: [big] })).toBeLessThan(2_000);
  });

  test('read returns an image file as an image', async () => {
    const ctx = { workspaceRoot: root } as ToolContext;
    const out = await readTool.run({ path: 'dot.png' }, ctx);
    expect(out).toMatchObject({ text: 'dot.png: PNG image', images: [{ mediaType: 'image/png' }] });
    await expect(readTool.run({ path: 'fake.png' }, ctx)).rejects.toThrow('not a PNG');
  });
});

describe('images in a session', () => {
  function setup(vision: boolean, extra: Record<string, unknown> = {}) {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000, vision } },
      routing: { start: ['local'] },
      permissions: { read: 'allow' },
      ...extra,
    });
    const lp = new ScriptedProvider('lp', 'local', [
      { toolCalls: [{ name: 'read', input: { path: 'dot.png' } }] },
      { text: 'a dot' },
    ]);
    const engine = new Engine({ workspaceRoot: root, config, providers: new Map([['lp', lp]]) });
    return { engine, lp };
  }

  test('pasted and read images reach a model with vision', async () => {
    const { engine, lp } = setup(true);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'what is this?', 'auto', undefined, undefined, [
      { kind: 'image', name: 'image 1', data: PNG.toString('base64') },
    ]);
    const [first, second] = lp.requests;
    expect(first?.messages[0]?.parts[1]).toMatchObject({
      type: 'image',
      attachment: { path: 'image 1' },
    });
    const result = second?.messages.at(-1)?.parts[0];
    expect(result).toMatchObject({ type: 'tool_result', images: [{ mediaType: 'image/png' }] });
  });

  test('a model without vision gets notes, and the transcript keeps the images', async () => {
    const { engine, lp } = setup(false);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'what is @dot.png?');
    expect(JSON.stringify(lp.requests[0]?.messages)).toContain(
      "image dot.png is attached, but this model can't see images",
    );
    expect(engine.getSession(s.id).messages[0]?.parts[1]).toMatchObject({ type: 'image' });
  });

  test('an image from a private path pins the session local', async () => {
    const { engine } = setup(true, { privacy: { localOnlyPaths: ['*.png'] } });
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'what is @dot.png?');
    expect(engine.getSession(s.id).messages[0]?.parts[1]).toMatchObject({
      type: 'image',
      private: 'attached dot.png',
    });
  });
});
