/** The installers switchback.harville.ai serves: scripts/install.sh and scripts/install.ps1. */
export const INSTALLERS = {
  unix: 'https://switchback.harville.ai/install.sh',
  windows: 'https://switchback.harville.ai/install.ps1',
} as const;

export type InstallPlatform = keyof typeof INSTALLERS;

/** The one-line install command for a platform, as the docs and the site show it. */
export function installCommand(platform: InstallPlatform): string {
  return platform === 'windows'
    ? `irm ${INSTALLERS.windows} | iex`
    : `curl -fsSL ${INSTALLERS.unix} | sh`;
}
