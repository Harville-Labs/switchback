import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { mouseInput } from './mouse.ts';
import { selection, spans } from './selection.ts';

describe('spans', () => {
  test('a drag on one row covers the columns between its ends, whichever way it went', () => {
    expect(spans({ x: 7, y: 2 }, { x: 3, y: 2 }, 20)).toEqual([{ y: 2, from: 3, to: 7 }]);
  });

  test('a drag over several rows runs to the end of the first and from the start of the last', () => {
    expect(spans({ x: 4, y: 3 }, { x: 9, y: 1 }, 20)).toEqual([
      { y: 1, from: 9, to: 20 },
      { y: 2, from: 1, to: 20 },
      { y: 3, from: 1, to: 4 },
    ]);
  });

  test('columns past the edge are clamped to the screen', () => {
    expect(spans({ x: 0, y: 1 }, { x: 30, y: 1 }, 20)).toEqual([{ y: 1, from: 1, to: 20 }]);
  });
});

describe('selecting with a drag', () => {
  const setup = () => {
    const input = new PassThrough();
    const mouse = mouseInput(
      input as unknown as NodeJS.ReadStream,
      new PassThrough() as unknown as NodeJS.WriteStream,
    );
    const output = Object.assign(new PassThrough(), { columns: 20, rows: 5, isTTY: true });
    const written: string[] = [];
    output.on('data', (d: Buffer) => written.push(d.toString()));
    const copied: string[] = [];
    const sel = selection(output as unknown as NodeJS.WriteStream, mouse, (t) => copied.push(t));
    const drag = async (seq: string) => {
      input.write(seq);
      await Bun.sleep(10);
    };
    const draw = async (text: string) => {
      sel.stdout.write(text);
      await Bun.sleep(10);
    };
    const done = () => {
      sel.dispose();
      mouse.dispose();
    };
    return { written, copied, drag, draw, done };
  };

  test('the dragged text is copied on release and shown inverted until a click', async () => {
    const { written, copied, drag, draw, done } = setup();
    await draw('hello world\nsecond line   ');
    written.length = 0;
    await drag('\x1b[<0;7;1M\x1b[<32;5;2M\x1b[<32;3;2M\x1b[<0;3;2m');
    expect(copied).toEqual(['world\nsec']);
    // Spaces at the end of a row are padding, not text.
    await drag('\x1b[<0;1;2M\x1b[<32;20;2M\x1b[<0;20;2m');
    expect(copied.at(-1)).toBe('second line');
    await drag('\x1b[<0;7;1M\x1b[<32;3;2M\x1b[<0;3;2m');
    const painted = written.at(-1) ?? '';
    // One style change per run of cells, not one per cell.
    expect(painted).toContain('\x1b[1;7H\x1b[0;7mworld');
    expect(painted).toContain('\x1b[2;1H\x1b[0;7msec');
    written.length = 0;
    await drag('\x1b[<0;1;4M\x1b[<0;1;4m');
    // The click puts the cells back as Ink drew them.
    expect(written.join('')).toContain('\x1b[1;7H\x1b[0mworld');
    done();
  });

  test('a frame that changes the selected text drops the highlight', async () => {
    const { written, copied, drag, draw, done } = setup();
    await draw('hello world');
    await drag('\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m');
    expect(copied).toEqual(['hello']);
    await draw('\x1b[1;1Hjello');
    written.length = 0;
    await drag('\x1b[<0;1;4M\x1b[<0;1;4m');
    expect(written).toEqual([]);
    done();
  });

  test('a frame that leaves the selected text alone keeps it highlighted', async () => {
    const { written, drag, draw, done } = setup();
    await draw('hello world');
    await drag('\x1b[<0;1;1M\x1b[<32;5;1M\x1b[<0;5;1m');
    written.length = 0;
    await draw('\x1b[3;1Hspinner');
    expect(written.at(-1)).toContain('\x1b[1;1H\x1b[0;7mh');
    done();
  });
});
