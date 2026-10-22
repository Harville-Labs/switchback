/**
 * The mouse in the full-screen TUI: the wheel scrolls and a click picks a
 * tab, an answer, or a picker row (Clickable.tsx). The terminal reports both
 * only once mouse reporting is on, and then as escape sequences on stdin
 * (`ESC [ < 64 ; x ; y M`), which Ink would hand to the prompt as keystrokes. So Ink reads from a stand-in stream: mouse events
 * are taken out and reported, and everything else passes through.
 *
 * The same stand-in asks whether the terminal speaks kitty's keyboard
 * protocol and keeps the answer from Ink. Ink's own detection listens for the
 * answer beside its reader, so the answer also reached the prompt as typed
 * text (`[?0u`), and a picker's filter then matched nothing.
 *
 * Mouse reporting also captures drags, so the TUI selects text itself
 * (selection.ts); Shift (Option in macOS Terminal and iTerm2) still gets the
 * terminal's own selection.
 * Windows users expect a plain drag to select and conhost has no modifier
 * that gets past reporting, so there it starts off; `/mouse` switches it and
 * the choice is saved.
 */
import { PassThrough } from 'node:stream';
import { prefsFile, readPrefs, savePref } from './prefs.ts';

/** Buttons, and motion while one is held (1002), in SGR coordinates (1006). */
const ENABLE = '\x1b[?1002h\x1b[?1006h';
const DISABLE = '\x1b[?1006l\x1b[?1002l';
const ESC = '\u001b';
const SGR_MOUSE = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, 'g');
/** A sequence cut off at the end of a chunk; the rest arrives with the next one. */
const PARTIAL = new RegExp(`${ESC}(\\[([<?\\d][\\d;]*)?)?$`);
/**
 * Answers to the queries in `kittyKeyboard()`: the keyboard flags
 * (`ESC [ ? flags u`) and the primary device attributes (`ESC [ ? … c`), which
 * every terminal sends. No key produces either.
 */
const KITTY_REPLY = new RegExp(`${ESC}\\[\\?\\d*u`, 'g');
const ATTRS_REPLY = new RegExp(`${ESC}\\[\\?[\\d;]*c`, 'g');
/** Ask for the keyboard flags, then the device attributes as a fallback answer. */
const KITTY_QUERY = '\x1b[?u\x1b[c';
/** How long to wait for a terminal that answers neither query. */
const KITTY_WAIT_MS = 200;
/** How long an Esc at the end of a read waits for the rest of a sequence before it's a key. */
const ESC_WAIT_MS = 20;
/**
 * Ctrl+Tab and Ctrl+Shift+Tab in xterm's modifyOtherKeys form. Ink reads only
 * the CSI u form (`ESC [ 9 ; 5 u`) that kitty, Ghostty, and WezTerm send.
 */
const XTERM_CTRL_TAB = new RegExp(`${ESC}\\[27;([56]);9~`, 'g');

export type WheelListener = (lines: number) => void;
/** A left click, in 1-based terminal columns and rows. */
export type ClickListener = (x: number, y: number) => void;
/** A 1-based terminal column and row. */
export interface Cell {
  x: number;
  y: number;
}
/** A left-button drag from `from` to `to`; `done` once the button is released. */
export type DragListener = (from: Cell, to: Cell, done: boolean) => void;
/** What the left button did: pressed, moved while held, or released. */
export interface Pointer extends Cell {
  kind: 'press' | 'move' | 'release';
}

/** Lines scrolled per wheel notch. */
const STEP = 3;

/** Mouse events and terminal answers in `chunk`, and what's left of it for Ink. */
export function takeMouse(chunk: string): {
  rest: string;
  deltas: number[];
  pointer: Pointer[];
  /** The terminal answered the keyboard flags query. */
  kitty: boolean;
  /** The terminal answered the device attributes query. */
  attrs: boolean;
} {
  const deltas: number[] = [];
  const pointer: Pointer[] = [];
  let kitty = false;
  let attrs = false;
  const rest = chunk
    .replace(KITTY_REPLY, () => {
      kitty = true;
      return '';
    })
    .replace(ATTRS_REPLY, () => {
      attrs = true;
      return '';
    })
    .replace(SGR_MOUSE, (_, code: string, x: string, y: string, end: string) => {
      const button = Number(code);
      // 64 and 65 are wheel up and down, with modifier bits (shift 4, alt 8, ctrl 16) added.
      if ((button & ~0b11100) === 64) deltas.push(-STEP);
      else if ((button & ~0b11100) === 65) deltas.push(STEP);
      // 32 marks motion; the left button is 0, and other buttons and modifiers are ignored.
      else if (button === 0 || button === 32) {
        const kind = end === 'm' ? 'release' : button === 32 ? 'move' : 'press';
        pointer.push({ kind, x: Number(x), y: Number(y) });
      }
      return '';
    })
    .replace(XTERM_CTRL_TAB, (_, mod: string) => `${ESC}[9;${mod}u`);
  return { rest, deltas, pointer, kitty, attrs };
}

/** Whether the terminal reports the mouse: the saved choice, else on everywhere but Windows. */
export function savedMouse(file = prefsFile(), platform = process.platform): boolean {
  const saved = readPrefs(file).mouse;
  return typeof saved === 'boolean' ? saved : platform !== 'win32';
}

export function saveMouse(on: boolean, file = prefsFile()): void {
  savePref('mouse', on, file);
}

export interface MouseInput {
  /** The stream to give Ink as `stdin`. */
  stdin: NodeJS.ReadStream;
  /** Whether the terminal is reporting the mouse (the wheel scrolls, clicks pick tabs). */
  readonly reporting: boolean;
  /** Turn reporting on, or off so a plain drag selects text. */
  setReporting(on: boolean): void;
  onWheel(listener: WheelListener): () => void;
  /** A left press and release with no movement between. */
  onClick(listener: ClickListener): () => void;
  onDrag(listener: DragListener): () => void;
  /**
   * Whether the terminal speaks kitty's keyboard protocol. Pass the answer to
   * Ink as `kittyKeyboard: { mode: 'enabled' }` or `'disabled'`, never `'auto'`.
   */
  kittyKeyboard(): Promise<boolean>;
  /** Turn mouse reporting off and stop reading; safe to call twice. */
  dispose(): void;
}

export function mouseInput(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  report = true,
): MouseInput {
  const listeners = new Set<WheelListener>();
  const clickListeners = new Set<ClickListener>();
  const dragListeners = new Set<DragListener>();
  // Where the left button went down, and whether it has moved since.
  let down: Cell | undefined;
  let dragged = false;
  const point = ({ kind, x, y }: Pointer) => {
    const at = { x, y };
    if (kind === 'press') {
      down = at;
      dragged = false;
      return;
    }
    if (!down) return;
    // Motion is reported only when the cell changes, so any move is a drag.
    if (kind === 'move') dragged = true;
    if (dragged) for (const l of dragListeners) l(down, at, kind === 'release');
    else if (kind === 'release') for (const l of clickListeners) l(down.x, down.y);
    if (kind === 'release') down = undefined;
  };
  const proxy = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
  let pending = '';
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  let answer: ((kitty: boolean) => void) | undefined;
  const onData = (data: Buffer | string) => {
    clearTimeout(escTimer);
    const text = pending + data.toString();
    pending = PARTIAL.exec(text)?.[0] ?? '';
    // A read can end right after the Esc that starts a wheel event. A lone Esc is
    // also the Esc key, so it goes on as one if nothing follows soon.
    if (pending === ESC)
      escTimer = setTimeout(() => {
        pending = '';
        proxy.write(ESC);
      }, ESC_WAIT_MS);
    const { rest, deltas, pointer, kitty, attrs } = takeMouse(
      pending ? text.slice(0, -pending.length) : text,
    );
    // The flags answer comes before the attributes one, so attributes alone means no.
    if (kitty || attrs) answer?.(kitty);
    for (const d of deltas) for (const l of listeners) l(d);
    for (const p of pointer) point(p);
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
  if (report) output.write(ENABLE);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(escTimer);
    output.write(DISABLE);
    input.off('data', onData);
    input.pause();
  };
  // Whatever ends the process, the shell shouldn't be left reporting the mouse.
  process.once('exit', dispose);
  return {
    stdin: proxy as unknown as NodeJS.ReadStream,
    get reporting() {
      return report;
    },
    setReporting(on) {
      if (disposed || on === report) return;
      report = on;
      output.write(on ? ENABLE : DISABLE);
    },
    onWheel(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClick(listener) {
      clickListeners.add(listener);
      return () => clickListeners.delete(listener);
    },
    onDrag(listener) {
      dragListeners.add(listener);
      return () => dragListeners.delete(listener);
    },
    kittyKeyboard() {
      if (!input.isTTY || !output.isTTY || disposed) return Promise.resolve(false);
      return new Promise((resolve) => {
        const timer = setTimeout(() => answer?.(false), KITTY_WAIT_MS);
        answer = (kitty) => {
          answer = undefined;
          clearTimeout(timer);
          resolve(kitty);
        };
        // A terminal still in line mode holds the answers until the next key,
        // well past the wait.
        input.setRawMode?.(true);
        output.write(KITTY_QUERY);
      });
    },
    dispose,
  };
}
