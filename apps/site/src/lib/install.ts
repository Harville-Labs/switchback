import { type InstallPlatform, installCommand } from '@harville-labs/switchback-org/install';

export type { InstallPlatform };

/** The command for each platform, as the console shows it. */
export const INSTALL_COMMANDS: Record<InstallPlatform, string> = {
  unix: installCommand('unix'),
  windows: installCommand('windows'),
};

/**
 * Which installer to show first, from the request: the `Sec-CH-UA-Platform` client
 * hint when the browser sends it (Chromium), else the User-Agent. Anything not
 * clearly Windows gets the shell script.
 */
export function installPlatform(headers: Headers): InstallPlatform {
  const hint = headers.get('sec-ch-ua-platform');
  if (hint) return /windows/i.test(hint) ? 'windows' : 'unix';
  return /windows/i.test(headers.get('user-agent') ?? '') ? 'windows' : 'unix';
}
