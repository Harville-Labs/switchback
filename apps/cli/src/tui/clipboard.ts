/**
 * Copying out of the TUI. Selecting text in a terminal picks up the
 * rendering (wrapped lines, code-block indentation), so `/copy` puts the raw
 * text on the clipboard instead (what to copy: `pickCopy` in @switchback/client).
 *
 * Two routes, both tried: OSC 52, which the terminal handles (iTerm2, kitty,
 * WezTerm, Ghostty, Windows Terminal, tmux with set-clipboard) and which works
 * over SSH; and the platform's clipboard command for terminals without it.
 * clipboardy would do the second part, but it ships helper binaries that don't
 * survive `bun build --compile`.
 */

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
