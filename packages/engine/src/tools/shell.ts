/**
 * Pick the shell the `bash` tool runs commands with. The tool keeps its name
 * on every platform (agent definitions and permission rules refer to it);
 * the system prompt tells the model which shell it actually has.
 */

export interface Shell {
  /** Human-readable, for the system prompt. */
  name: string;
  argv: (command: string) => string[];
}

type Which = (cmd: string) => string | null;

export function detectShell(
  platform: NodeJS.Platform = process.platform,
  which: Which = Bun.which,
): Shell {
  if (platform !== 'win32') {
    const bash = which('bash');
    if (bash) return { name: 'bash', argv: (c) => [bash, '-c', c] };
    return { name: 'sh', argv: (c) => ['/bin/sh', '-c', c] };
  }
  // Git Bash when installed. System32\bash.exe is the WSL launcher, which runs
  // in a Linux VM rather than the Windows workspace, so skip it.
  const bash = which('bash');
  if (bash && !/[\\/]system32[\\/]/i.test(bash)) {
    return { name: 'bash (Git Bash on Windows)', argv: (c) => [bash, '-c', c] };
  }
  const pwsh = which('pwsh') ?? which('powershell');
  if (pwsh) {
    return {
      name: `PowerShell (${pwsh.toLowerCase().includes('pwsh') ? 'pwsh' : 'Windows PowerShell'}); write PowerShell, not bash`,
      argv: (c) => [pwsh, '-NoProfile', '-NonInteractive', '-Command', c],
    };
  }
  return { name: 'cmd.exe; write cmd syntax', argv: (c) => ['cmd.exe', '/d', '/s', '/c', c] };
}

let cached: Shell | undefined;
export function currentShell(): Shell {
  cached ??= detectShell();
  return cached;
}
