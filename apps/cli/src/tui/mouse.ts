/**
 * Mouse-wheel scrolling for the full-screen TUI. The terminal reports the
 * wheel only once mouse reporting is on, and then as escape sequences on
 * stdin (`ESC [ < 64 ; x ; y M`), which Ink would hand to the prompt as
 * keystrokes. So Ink reads from a stand-in stream: wheel events are taken
 * out and reported, and everything else passes through untouched.
 *
 * Mouse reporting also captures clicks, so selecting text takes Shift (or
 * Option in macOS Terminal and iTerm2) while dragging; /copy copies replies.
 */
import { PassThrough } from 'node:stream';

/** Button and motion events (1000) in SGR coordinates (1006). */
const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';
const ESC = '\u001b';
const SGR_MOUSE = new RegExp(`${ESC}\\[<(\\d+);\\d+;\\d+[Mm]`, 'g');
/** A sequence cut off at the end of a chunk; the rest arrives with the next one. */
const PARTIAL = new RegExp(`${ESC}(\\[(<[\\d;]*)?)?$`);

export type WheelListener = (lines: number) => void;

/** Lines scrolled per wheel notch. */
const STEP = 3;

/** Wheel events in `chunk`, and what's left of it for Ink. */
export function takeWheel(chunk: string): { rest: string; deltas: number[] } {
  const deltas: number[] = [];
  const rest = chunk.replace(SGR_MOUSE, (_, code: string) => {
    const button = Number(code);
    // 64 and 65 are wheel up and down, with modifier bits (shift 4, alt 8, ctrl 16) added.
    if ((button & ~0b11100) === 64) deltas.push(-STEP);
    else if ((button & ~0b11100) === 65) deltas.push(STEP);
    return '';
  });
  return { rest, deltas };
}

export interface MouseInput {
  /** The stream to give Ink as `stdin`. */
  stdin: NodeJS.ReadStream;
  onWheel(listener: WheelListener): () => void;
  /** Turn mouse reporting off and stop reading; safe to call twice. */
  dispose(): void;
}

export function mouseInput(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): MouseInput {
  const listeners = new Set<WheelListener>();
  const proxy = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
  let pending = '';
  const onData = (data: Buffer | string) => {
    const text = pending + data.toString();
    const cut = PARTIAL.exec(text);
    // A lone Esc is a keypress, not the start of a sequence; Ink times it out itself.
    pending = cut && cut[0] !== ESC ? cut[0] : '';
    const { rest, deltas } = takeWheel(pending ? text.slice(0, -pending.length) : text);
    for (const d of deltas) for (const l of listeners) l(d);
    if (rest) proxy.write(rest);
  };
  Object.assign(proxy, {
    isTTY: input.isTTY,
    setRawMode: (mode: boolean) => {
      input.setRawMode?.(mode);
      return proxy;
    },
    ref: () => {
      input.ref();
      return proxy;
    },
    unref: () => {
      input.unref();
      return proxy;
    },
  });
  input.on('data', onData);
  output.write(ENABLE);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    output.write(DISABLE);
    input.off('data', onData);
    input.pause();
  };
  // Whatever ends the process, the shell shouldn't be left reporting the mouse.
  process.once('exit', dispose);
  return {
    stdin: proxy as unknown as NodeJS.ReadStream,
    onWheel(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
}
