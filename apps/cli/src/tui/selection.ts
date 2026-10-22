/**
 * Selecting text with a plain drag. Mouse reporting keeps drags from the
 * terminal's own selection, and turning it off hands the wheel to the terminal,
 * which sends it as ↑↓ keys that walk prompt history. So the TUI selects for
 * itself: it keeps a copy of the screen (an @xterm/headless terminal fed
 * everything Ink writes), paints the selected cells inverted, and copies their
 * text when the button comes up.
 */
import { type IBufferCell, Terminal } from '@xterm/headless';
import type { Cell, MouseInput } from './mouse.ts';

/** One row of a selection: columns `from` to `to`, 1-based and inclusive. */
export interface Span {
  y: number;
  from: number;
  to: number;
}

/** The rows a drag between `a` and `b` covers, in reading order, the way terminals select. */
export function spans(a: Cell, b: Cell, cols: number): Span[] {
  const [start, end] = a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  const clamp = (x: number) => Math.min(cols, Math.max(1, x));
  const rows: Span[] = [];
  for (let y = start.y; y <= end.y; y++)
    rows.push({
      y,
      from: y === start.y ? clamp(start.x) : 1,
      to: y === end.y ? clamp(end.x) : cols,
    });
  return rows;
}

function colorCodes(base: 38 | 48, rgb: boolean, palette: boolean, value: number): string[] {
  if (rgb) return [`${base};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`];
  return palette ? [`${base};5;${value}`] : [];
}

/** The SGR parameters that draw `cell` as it is, or with inverse flipped. */
function sgr(cell: IBufferCell, invert: boolean): string {
  const codes = ['0'];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  if (cell.isUnderline()) codes.push('4');
  if (Boolean(cell.isInverse()) !== invert) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  codes.push(...colorCodes(38, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()));
  codes.push(...colorCodes(48, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()));
  return codes.join(';');
}

/** Escape sequences that redraw `rows` from the model, inverted or as they are. */
function paint(term: Terminal, rows: Span[], invert: boolean): string {
  const buffer = term.buffer.active;
  let out = '';
  let cell: IBufferCell | undefined;
  for (const { y, from, to } of rows) {
    const line = buffer.getLine(buffer.viewportY + y - 1);
    if (!line) continue;
    let x = from;
    // The right half of a wide character is drawn with the cell before it.
    if (x > 1 && line.getCell(x - 1)?.getWidth() === 0) x--;
    out += `\x1b[${y};${x}H`;
    let style = '';
    for (; x <= to; x++) {
      cell = line.getCell(x - 1, cell);
      if (!cell || cell.getWidth() === 0) continue;
      const next = sgr(cell, invert);
      if (next !== style) out += `\x1b[${next}m`;
      style = next;
      out += cell.getChars() || ' ';
    }
  }
  // Save and restore the cursor, so Ink's next frame starts where it left off.
  return out && `\x1b7${out}\x1b[0m\x1b8`;
}

function textOf(term: Terminal, rows: Span[]): string {
  const buffer = term.buffer.active;
  return rows
    .map(
      ({ y, from, to }) =>
        buffer
          .getLine(buffer.viewportY + y - 1)
          ?.translateToString(false, from - 1, to)
          .trimEnd() ?? '',
    )
    .join('\n');
}

export interface Selection {
  /** The stream to give Ink as `stdout`. */
  stdout: NodeJS.WriteStream;
  dispose(): void;
}

/**
 * Select with a left drag on `output`; `copy` gets the text on release. The
 * highlight stays until a click, the wheel, a resize, or a frame that changes
 * the text under it.
 */
export function selection(
  output: NodeJS.WriteStream,
  mouse: Pick<MouseInput, 'onDrag' | 'onClick' | 'onWheel'>,
  copy: (text: string) => void,
): Selection {
  const term = new Terminal({
    cols: output.columns || 80,
    rows: output.rows || 24,
    allowProposedApi: true,
    // The tty turns Ink's \n into \r\n on the way out; the model needs the same.
    convertEol: true,
    scrollback: 0,
  });
  let rows: Span[] = [];
  let selected = '';
  let parsing = 0;
  const show = (next: Span[]) => {
    const out = paint(term, rows, false) + paint(term, next, true);
    rows = next;
    if (out) output.write(out);
  };
  // A frame may draw over the highlight. Repaint once the model has caught up
  // with everything written, or the cells it paints may be a frame behind.
  const framed = () => {
    if (--parsing > 0 || rows.length === 0) return;
    if (textOf(term, rows) === selected) output.write(paint(term, rows, true));
    else show([]);
  };
  const write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    parsing++;
    term.write(chunk, framed);
    return (output.write as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  const stdout = new Proxy(output, {
    get(target, prop) {
      if (prop === 'write') return write;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const clear = () => {
    if (rows.length) show([]);
  };
  const resized = () => {
    // Ink redraws everything after a resize, so there is nothing to unpaint.
    rows = [];
    term.resize(output.columns || term.cols, output.rows || term.rows);
  };
  output.on('resize', resized);
  const off = [
    mouse.onDrag((from, to, done) => {
      const next = spans(from, to, term.cols);
      show(next);
      selected = textOf(term, next);
      if (done && selected.trim()) copy(selected);
    }),
    mouse.onClick(clear),
    mouse.onWheel(clear),
  ];
  return {
    stdout,
    dispose() {
      for (const unsubscribe of off) unsubscribe();
      output.off('resize', resized);
      term.dispose();
    },
  };
}
