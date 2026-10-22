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
    expect(written.join('')).toBe('\x1b[?1000h\x1b[?1006h');
    mouse.setReporting(true);
    mouse.setReporting(false);
    expect(written.join('')).toBe('\x1b[?1000h\x1b[?1006h\x1b[?1006l\x1b[?1000l');
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
