/**
 * The mouse in the full-screen TUI: the wheel scrolls and a click picks a
 * tab. The terminal reports both only once mouse reporting is on, and then as
 * escape sequences on stdin (`ESC [ < 64 ; x ; y M`), which Ink would hand to
 * the prompt as keystrokes. So Ink reads from a stand-in stream: mouse events
 * are taken out and reported, and everything else passes through.
 *
 * Mouse reporting also captures clicks, so selecting text takes Shift (or
 * Option in macOS Terminal and iTerm2) while dragging; /copy copies replies.
 */
import { PassThrough } from 'node:stream';

/** Button and motion events (1000) in SGR coordinates (1006). */
const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1000l';
const ESC = '\u001b';
const SGR_MOUSE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');
/** A sequence cut off at the end of a chunk; the rest arrives with the next one. */
const PARTIAL = new RegExp(`${ESC}(\\[([<\\d][\\d;]*)?)?$`);
/**
 * Ctrl+Tab and Ctrl+Shift+Tab in xterm's modifyOtherKeys form. Ink reads only
 * the CSI u form (`ESC [ 9 ; 5 u`) that kitty, Ghostty, and WezTerm send.
 */
const XTERM_CTRL_TAB = new RegExp(`${ESC}\\[27;([56]);9~`, 'g');

export type WheelListener = (lines: number) => void;
/** A left click, in 1-based terminal columns and rows. */
export type ClickListener = (x: number, y: number) => void;

/** Lines scrolled per wheel notch. */
const STEP = 3;

/** Mouse events in `chunk`, and what's left of it for Ink. */
export function takeMouse(chunk: string): {
  rest: string;
  deltas: number[];
  clicks: [number, number][];
} {
  const deltas: number[] = [];
  const clicks: [number, number][] = [];
  const rest = chunk
    .replace(SGR_MOUSE, (_, code: string, x: string, y: string, end: string) => {
      const button = Number(code);
      // 64 and 65 are wheel up and down, with modifier bits (shift 4, alt 8, ctrl 16) added.
      if ((button & ~0b11100) === 64) deltas.push(-STEP);
      else if ((button & ~0b11100) === 65) deltas.push(STEP);
      else if (button === 0 && end === 'M') clicks.push([Number(x), Number(y)]);
      return '';
    })
    .replace(XTERM_CTRL_TAB, (_, mod: string) => `${ESC}[9;${mod}u`);
  return { rest, deltas, clicks };
}

export interface MouseInput {
  /** The stream to give Ink as `stdin`. */
  stdin: NodeJS.ReadStream;
  onWheel(listener: WheelListener): () => void;
  onClick(listener: ClickListener): () => void;
  /** Turn mouse reporting off and stop reading; safe to call twice. */
  dispose(): void;
}

export function mouseInput(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): MouseInput {
  const listeners = new Set<WheelListener>();
  const clickListeners = new Set<ClickListener>();
  const proxy = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
  let pending = '';
  const onData = (data: Buffer | string) => {
    const text = pending + data.toString();
    const cut = PARTIAL.exec(text);
    // A lone Esc is a keypress, not the start of a sequence; Ink times it out itself.
    pending = cut && cut[0] !== ESC ? cut[0] : '';
    const { rest, deltas, clicks } = takeMouse(pending ? text.slice(0, -pending.length) : text);
    for (const d of deltas) for (const l of listeners) l(d);
    for (const [x, y] of clicks) for (const l of clickListeners) l(x, y);
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
  // A 'data' listener doesn't restart a stream that was paused on purpose, and
  // setup's prompts pause stdin when they close; without this, keys go nowhere.
  input.resume();
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
    onClick(listener) {
      clickListeners.add(listener);
      return () => clickListeners.delete(listener);
    },
    dispose,
  };
}
