/**
 * Copying out of the TUI. Selecting text in a terminal picks up the
 * rendering (wrapped lines, code-block indentation), so `/copy` puts the raw
 * text on the clipboard instead.
 *
 * Two routes, both tried: OSC 52, which the terminal handles (iTerm2, kitty,
 * WezTerm, Ghostty, Windows Terminal, tmux with set-clipboard) and which works
 * over SSH; and the platform's clipboard command for terminals without it.
 * clipboardy would do the second part, but it ships helper binaries that don't
 * survive `bun build --compile`.
 */
import { Lexer } from 'marked';

/** The raw text of each fenced or indented code block, in order. */
export function codeBlocks(markdown: string): string[] {
  return new Lexer()
    .lex(markdown)
    .flatMap((t) => (t.type === 'code' ? [(t as { text: string }).text] : []));
}

/** What `/copy [arg]` copies from a reply: the whole reply, or code block `n` (1-based). */
export function pickCopy(
  reply: string,
  arg: string | undefined,
): { text: string; what: string } | { error: string } {
  if (!arg) return { text: reply, what: 'the last reply' };
  const blocks = codeBlocks(reply);
  if (!blocks.length) return { error: 'the last reply has no code blocks; /copy copies all of it' };
  const n = arg === 'code' ? 1 : Number(arg);
  if (!Number.isInteger(n) || n < 1 || n > blocks.length)
    return {
      error: `the last reply has ${blocks.length} code block${blocks.length === 1 ? '' : 's'}: /copy 1${blocks.length > 1 ? `…${blocks.length}` : ''}`,
    };
  return { text: blocks[n - 1] as string, what: `code block ${n} of ${blocks.length}` };
}

export function osc52(text: string): string {
  const seq = `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
  // tmux passes it through only when wrapped.
  return process.env.TMUX ? `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : seq;
}

function nativeCommands(): string[][] {
  if (process.platform === 'darwin') return [['pbcopy']];
  if (process.platform === 'win32')
    return [['powershell', '-NoProfile', '-Command', '$input | Set-Clipboard']];
  return [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
}

/** Copy via OSC 52 and the native clipboard. Resolves to whether a native command succeeded. */
export async function copyText(text: string, write: (s: string) => void): Promise<boolean> {
  write(osc52(text));
  // Over SSH the local clipboard is the one that matters, and only OSC 52 reaches it.
  if (process.env.SSH_CONNECTION) return false;
  for (const cmd of nativeCommands()) {
    if (!Bun.which(cmd[0] as string)) continue;
    try {
      const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
      proc.stdin.write(text);
      await proc.stdin.end();
      if ((await proc.exited) === 0) return true;
    } catch {
      // try the next one
    }
  }
  return false;
}
