/**
 * The terminal's window and tab title follows the session in front. The
 * title the shell had is pushed onto xterm's title stack first and popped on
 * exit; terminals without the stack ignore both, and keep our last title.
 */
import { terminalTitle } from '@switchback/client';

export function terminalTitles(out: { write(s: string): unknown }) {
  let last: string | undefined;
  out.write('\x1b[22;0t');
  return {
    set(title: string | undefined) {
      const next = terminalTitle(title);
      if (next === last) return;
      last = next;
      out.write(`\x1b]0;${next}\x07`);
    },
    restore() {
      out.write('\x1b[23;0t');
    },
  };
}
