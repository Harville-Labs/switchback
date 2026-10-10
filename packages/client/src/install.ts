/** The installers (scripts/install.sh and scripts/install.ps1) at their short addresses on switchback.sh, which redirect to the console at app.switchback.sh that serves them. */
export const INSTALLERS = {
  unix: 'https://switchback.sh/install.sh',
  windows: 'https://switchback.sh/install.ps1',
} as const;

export type InstallPlatform = keyof typeof INSTALLERS;

/** The one-line install command for a platform, as the docs and the site show it. */
export function installCommand(platform: InstallPlatform): string {
  return platform === 'windows'
    ? `irm ${INSTALLERS.windows} | iex`
    : `curl -fsSL ${INSTALLERS.unix} | sh`;
}
