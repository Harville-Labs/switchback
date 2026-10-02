/**
 * Which switchback binary the extension runs. The `switchback.executablePath`
 * setting wins. Otherwise the CLI (on PATH, or where the installer puts it) when
 * it's at least as new as the engine bundled in this .vsix, so the terminal and
 * VS Code run one engine; else the bundled one.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, INSTALLERS, installCommand } from '@switchback/client';

export interface EngineBinary {
  command: string;
  args: string[];
  /** What `--version` printed; undefined when it couldn't be run. */
  version?: string;
  source: 'setting' | 'cli' | 'bundled';
}

export function chooseEngine(found: {
  setting?: EngineBinary;
  cli?: EngineBinary;
  bundled?: EngineBinary;
}): EngineBinary | undefined {
  if (found.setting) return found.setting;
  const { cli, bundled } = found;
  if (!cli?.version) return bundled;
  if (!bundled?.version) return cli;
  return (compareVersions(cli.version, bundled.version) ?? -1) >= 0 ? cli : bundled;
}

/** Run `<command> [args] --version`; undefined unless it prints a version. */
export function probeVersion(
  command: string,
  args: string[] = [],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args, '--version'],
      { timeout: 5000, env, windowsHide: true },
      (err, stdout) => {
        const version = String(stdout).trim().split(/\r?\n/)[0] ?? '';
        // Anything else is some other program that happens to be called switchback.
        resolve(!err && /^\d+\.\d+\.\d+/.test(version) ? version : undefined);
      },
    );
  });
}

/**
 * Where the installers put the CLI. VS Code's PATH can miss it: a window
 * opened before the install, or a profile that adds ~/.local/bin only for
 * interactive shells.
 */
export function installedCliPaths(platform = process.platform, home = homedir()): string[] {
  return [join(home, '.local', 'bin', platform === 'win32' ? 'switchback.exe' : 'switchback')];
}

/** The switchback CLI, if one runs: from PATH first, then the installer's location. */
export async function findCli(env?: NodeJS.ProcessEnv): Promise<EngineBinary | undefined> {
  for (const command of ['switchback', ...installedCliPaths()]) {
    const version = await probeVersion(command, [], env);
    if (version) return { command, args: [], version, source: 'cli' };
  }
  return undefined;
}

/** The terminal command that runs this platform's installer. */
export function installerShell(platform = process.platform): {
  shellPath: string;
  shellArgs: string[];
} {
  if (platform === 'win32')
    return {
      shellPath: 'powershell.exe',
      shellArgs: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${installCommand('windows')}; Read-Host 'Press Enter to close'`,
      ],
    };
  return {
    shellPath: '/bin/sh',
    shellArgs: [
      '-c',
      `{ curl -fsSL ${INSTALLERS.unix} || wget -qO- ${INSTALLERS.unix}; } | sh; printf '\\nPress Enter to close'; read _`,
    ],
  };
}
