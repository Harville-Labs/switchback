import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mouseInput, savedMouse, saveMouse, takeMouse } from './mouse.ts';
import { savedTheme, saveTheme } from './theme.ts';

describe('mouse input', () => {
  test('wheel events come out of the input; keys and clicks never reach the prompt as text', () => {
    expect(takeMouse('a\x1b[<64;10;5Mb\x1b[<65;1;1M')).toMatchObject({
      rest: 'ab',
      deltas: [-3, 3],
    });
    // Shift+wheel (64 + 4) still scrolls; the left button is reported but never typed.
    expect(takeMouse('\x1b[<68;1;1M\x1b[<0;3;4M\x1b[<32;5;4M\x1b[<0;5;4m')).toMatchObject({
      rest: '',
      deltas: [-3],
      pointer: [
        { kind: 'press', x: 3, y: 4 },
        { kind: 'move', x: 5, y: 4 },
        { kind: 'release', x: 5, y: 4 },
      ],
    });
    // The right button is neither typed nor reported.
    expect(takeMouse('\x1b[<2;3;4M\x1b[<2;3;4m')).toMatchObject({ rest: '', pointer: [] });
    expect(takeMouse('\x1b[A')).toMatchObject({ rest: '\x1b[A', deltas: [] });
  });

  test("xterm's ctrl+tab and ctrl+shift+tab reach Ink in the CSI u form it reads", () => {
    expect(takeMouse('\x1b[27;5;9~\x1b[27;6;9~').rest).toBe('\x1b[9;5u\x1b[9;6u');
  });

  test("the terminal's answers to the keyboard queries never reach the prompt", () => {
    expect(takeMouse('a\x1b[?0ub\x1b[?62;22cc')).toMatchObject({
      rest: 'abc',
      kitty: true,
      attrs: true,
    });
    expect(takeMouse('\x1b[?1;2c')).toMatchObject({ rest: '', kitty: false, attrs: true });
  });

  describe('asking for the kitty keyboard protocol', () => {
    const terminal = () => {
      const input = Object.assign(new PassThrough(), { isTTY: true, raw: false });
      Object.assign(input, { setRawMode: (on: boolean) => Object.assign(input, { raw: on }) });
      const output = Object.assign(new PassThrough(), { isTTY: true });
      const written: string[] = [];
      output.on('data', (d: Buffer) => written.push(d.toString()));
      const mouse = mouseInput(
        input as unknown as NodeJS.ReadStream,
        output as unknown as NodeJS.WriteStream,
        false,
      );
      const typed: string[] = [];
      mouse.stdin.on('data', (d: Buffer) => typed.push(d.toString()));
      return { input, written, mouse, typed };
    };

    test('a terminal that answers the flags query has it, and the answer is not typed', async () => {
      const { input, written, mouse, typed } = terminal();
      const asked = mouse.kittyKeyboard();
      // Raw mode first: in line mode the answer waits for the next key.
      expect(input.raw).toBe(true);
      expect(written.join('')).toBe('\x1b[?u\x1b[c');
      // The answer split across two reads, then a key.
      input.write('\x1b[?0');
      input.write('u\x1b[?62;22c');
      input.write('x');
      expect(await asked).toBe(true);
      await Bun.sleep(0);
      expect(typed.join('')).toBe('x');
      mouse.dispose();
    });

    test('a terminal that answers only the attributes query does not', async () => {
      const { input, mouse, typed } = terminal();
      const asked = mouse.kittyKeyboard();
      input.write('\x1b[?1;2c');
      expect(await asked).toBe(false);
      await Bun.sleep(0);
      expect(typed).toEqual([]);
      mouse.dispose();
    });

    test('a terminal that answers neither is given up on', async () => {
      const { mouse } = terminal();
      expect(await mouse.kittyKeyboard()).toBe(false);
      mouse.dispose();
    });
  });

  test('a wheel event split after its Esc scrolls; a lone Esc still arrives as a key', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mouse = mouseInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const typed: string[] = [];
    mouse.stdin.on('data', (d: Buffer) => typed.push(d.toString()));
    const scrolled: number[] = [];
    mouse.onWheel((d) => scrolled.push(d));
    // A trackpad flick fills the read buffer, which can end anywhere.
    input.write('\x1b[<64;10;5M\x1b');
    input.write('[<64;10;5M');
    await Bun.sleep(0);
    expect(scrolled).toEqual([-3, -3]);
    expect(typed).toEqual([]);
    input.write('\x1b');
    await Bun.sleep(50);
    expect(typed).toEqual(['\x1b']);
    mouse.dispose();
  });

  test('a press and release in place is a click; moving between them is a drag instead', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mouse = mouseInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );
    const clicks: [number, number][] = [];
    const drags: string[] = [];
    mouse.onClick((x, y) => clicks.push([x, y]));
    mouse.onDrag((from, to, done) =>
      drags.push(`${from.x},${from.y}>${to.x},${to.y}${done ? '.' : ''}`),
    );
    input.write('\x1b[<0;3;4M\x1b[<0;3;4m');
    input.write('\x1b[<0;2;2M\x1b[<32;6;2M\x1b[<32;9;3M\x1b[<0;9;3m');
    // A release with no press, such as one that began before the TUI did, does nothing.
    input.write('\x1b[<0;1;1m');
    await Bun.sleep(0);
    expect(clicks).toEqual([[3, 4]]);
    expect(drags).toEqual(['2,2>6,2', '2,2>9,3', '2,2>9,3.']);
    mouse.dispose();
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

  test('reporting starts off when asked and switches with escape sequences', () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on('data', (d: Buffer) => written.push(d.toString()));
    const mouse = mouseInput(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      false,
    );
    expect(written).toEqual([]);
    mouse.setReporting(true);
    expect(mouse.reporting).toBe(true);
    expect(written.join('')).toBe('\x1b[?1002h\x1b[?1006h');
    mouse.setReporting(true);
    mouse.setReporting(false);
    expect(written.join('')).toBe('\x1b[?1002h\x1b[?1006h\x1b[?1006l\x1b[?1002l');
    mouse.dispose();
  });

  test('Windows starts with plain drag-to-select; a saved choice wins everywhere', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'switchback-prefs-')), 'tui.json');
    expect(savedMouse(file, 'win32')).toBe(false);
    expect(savedMouse(file, 'darwin')).toBe(true);
    expect(savedMouse(file, 'linux')).toBe(true);
    saveMouse(true, file);
    expect(savedMouse(file, 'win32')).toBe(true);
    saveMouse(false, file);
    expect(savedMouse(file, 'linux')).toBe(false);
  });

  test('saving the theme keeps the mouse choice, and the other way round', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'switchback-prefs-')), 'tui.json');
    saveMouse(false, file);
    saveTheme('light', file);
    saveMouse(false, file);
    expect(savedTheme(file)).toBe('light');
    expect(savedMouse(file, 'darwin')).toBe(false);
  });
});
