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

/** Run a command and return its stdout as bytes, or undefined if it fails or isn't installed. */
async function output(cmd: string[]): Promise<Uint8Array | undefined> {
  if (!Bun.which(cmd[0] as string)) return undefined;
  try {
    const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const [bytes, code] = await Promise.all([new Response(proc.stdout).bytes(), proc.exited]);
    return code === 0 && bytes.length ? bytes : undefined;
  } catch {
    return undefined;
  }
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : '');

/**
 * The image on the system clipboard, as base64 (PNG on every platform), or
 * undefined when there isn't one. Terminals paste only text, so ctrl+v asks
 * the platform instead. Over SSH the clipboard is on another machine; drag
 * the file in or mention it with @ there.
 */
export async function readClipboardImage(): Promise<string | undefined> {
  if (process.env.SSH_CONNECTION) return undefined;
  if (process.platform === 'darwin') {
    // AppleScript prints the PNG as hex: «data PNGf89504E47…»
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(
      text(await output(['osascript', '-e', 'the clipboard as «class PNGf»'])),
    )?.[1];
    return hex ? Buffer.from(hex, 'hex').toString('base64') : undefined;
  }
  if (process.platform === 'win32') {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { $m = New-Object IO.MemoryStream; $i.Save($m, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray()) }';
    const b64 = text(await output(['powershell', '-NoProfile', '-STA', '-Command', script])).trim();
    return b64 || undefined;
  }
  // Wayland, then X11; each lists what the clipboard holds before reading it.
  if (text(await output(['wl-paste', '--list-types'])).includes('image/png')) {
    const png = await output(['wl-paste', '--type', 'image/png']);
    if (png) return Buffer.from(png).toString('base64');
  }
  if (
    text(await output(['xclip', '-selection', 'clipboard', '-t', 'TARGETS', '-o'])).includes(
      'image/png',
    )
  ) {
    const png = await output(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o']);
    if (png) return Buffer.from(png).toString('base64');
  }
  return undefined;
}
