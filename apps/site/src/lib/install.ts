/** The one-line installers that switchback.harville.ai serves (scripts/install.sh and install.ps1). */
export const INSTALL_COMMANDS = {
  unix: 'curl -fsSL https://switchback.harville.ai/install.sh | sh',
  windows: 'irm https://switchback.harville.ai/install.ps1 | iex',
} as const;

export type InstallPlatform = keyof typeof INSTALL_COMMANDS;

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
