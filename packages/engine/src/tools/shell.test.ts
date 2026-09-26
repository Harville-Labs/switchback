import { expect, test } from 'bun:test';
import { detectShell } from './shell.ts';

const which = (found: Record<string, string>) => (cmd: string) => found[cmd] ?? null;

test('unix prefers bash, falls back to sh', () => {
  expect(detectShell('linux', which({ bash: '/usr/bin/bash' })).argv('ls')).toEqual([
    '/usr/bin/bash',
    '-c',
    'ls',
  ]);
  expect(detectShell('linux', which({})).name).toBe('sh');
});

test('windows uses Git Bash but never the WSL launcher', () => {
  const git = detectShell(
    'win32',
    which({ bash: 'C:\\Program Files\\Git\\bin\\bash.exe', pwsh: 'C:\\pwsh.exe' }),
  );
  expect(git.name).toContain('Git Bash');
  const wsl = detectShell(
    'win32',
    which({
      bash: 'C:\\Windows\\System32\\bash.exe',
      pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    }),
  );
  expect(wsl.name).toContain('PowerShell');
  expect(wsl.argv('dir')).toEqual([
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'dir',
  ]);
});

test('windows without bash or PowerShell falls back to cmd', () => {
  expect(detectShell('win32', which({})).argv('dir')[0]).toBe('cmd.exe');
});
