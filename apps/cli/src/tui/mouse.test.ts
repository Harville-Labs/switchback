import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { mouseInput, takeMouse } from './mouse.ts';

describe('mouse input', () => {
  test('wheel events come out of the input; keys and clicks never reach the prompt as text', () => {
    expect(takeMouse('a\x1b[<64;10;5Mb\x1b[<65;1;1M')).toMatchObject({
      rest: 'ab',
      deltas: [-3, 3],
    });
    // Shift+wheel (64 + 4) still scrolls; a click is reported but never typed.
    expect(takeMouse('\x1b[<68;1;1M\x1b[<0;3;4M\x1b[<0;3;4m')).toEqual({
      rest: '',
      deltas: [-3],
      clicks: [[3, 4]],
    });
    expect(takeMouse('\x1b[A')).toMatchObject({ rest: '\x1b[A', deltas: [] });
  });

  test("xterm's ctrl+tab and ctrl+shift+tab reach Ink in the CSI u form it reads", () => {
    expect(takeMouse('\x1b[27;5;9~\x1b[27;6;9~').rest).toBe('\x1b[9;5u\x1b[9;6u');
  });

  test('keys reach Ink even when stdin was paused by an earlier prompt', async () => {
    const input = new PassThrough();
    input.pause();
    const output = new PassThrough();
    const mouse = mouseInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const got = new Promise<string>((resolve) =>
      mouse.stdin.once('data', (d: Buffer) => resolve(d.toString())),
    );
    input.write('hi');
    expect(await got).toBe('hi');
    mouse.dispose();
  });
});
