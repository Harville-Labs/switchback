/**
 * `switchback self-update [--version <x.y.z>] [--check]`: replace this binary
 * with the newest release (or a chosen one), verified against the release's
 * SHA256SUMS, the same way scripts/install.sh and install.ps1 install it.
 *
 * The new binary is written next to the old one and renamed over it, so a
 * failed download never leaves a broken install. Windows can't overwrite a
 * running .exe but can rename it, so the old one steps aside first.
 *
 * A running shared engine keeps its version until it exits; the next client
 * of the new version takes over from it (docs/architecture.md).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareVersions } from '@switchback/client';
import { CLI_VERSION } from '../bootstrap.ts';
import { bold, dim, green } from '../prompt.ts';

const RELEASES = 'https://github.com/Harville-Labs/switchback/releases';

export interface SelfUpdateOptions {
  /** A specific release instead of the newest. */
  version?: string;
  /** Only report whether an update exists. */
  check?: boolean;
  /** Injected for tests; default: this process. */
  exePath?: string;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

class UpdateError extends Error {}

/** The release asset suffix for this machine, as the release workflow names it. */
export function releasePlatform(platform: NodeJS.Platform, arch: string): string {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : '';
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : '';
  if (!os || !cpu)
    throw new UpdateError(`Switchback has no build for ${platform}-${arch}. See ${RELEASES}.`);
  if (os === 'windows') return 'windows-x64.exe'; // Windows on Arm runs the x64 build.
  // An x64 binary under Rosetta on Apple silicon: move to the native build.
  if (os === 'darwin' && cpu === 'x64') {
    const translated = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
    if (translated.stdout?.trim() === '1') return 'darwin-arm64';
  }
  return `${os}-${cpu}`;
}

export async function selfUpdate(o: SelfUpdateOptions = {}): Promise<number> {
  const log = o.log ?? ((line: string) => console.log(line));
  try {
    return await update(o, log);
  } catch (err) {
    if (!(err instanceof UpdateError)) throw err;
    process.stderr.write(`switchback self-update: ${err.message}\n`);
    return 1;
  }
}

async function update(o: SelfUpdateOptions, log: (line: string) => void): Promise<number> {
  const env = o.env ?? process.env;
  const get = o.fetch ?? fetch;
  const current = o.currentVersion ?? CLI_VERSION;
  const exe = o.exePath ?? process.execPath;
  // What a previous update on Windows moved aside; it can go once nothing runs it.
  try {
    rmSync(join(dirname(exe), `.${basename(exe)}.old`), { force: true });
  } catch {
    // Still running (an older shared engine); the next update removes it.
  }
  // From source (`bun apps/cli/src/main.ts`), process.execPath is bun itself.
  if (!o.exePath && /^bun(\.exe)?$/i.test(basename(exe)))
    throw new UpdateError('this is a development build run with bun; update it with git pull.');
  const base = (env.SWITCHBACK_DOWNLOAD_URL ?? `${RELEASES}/download`).replace(/\/+$/, '');
  const api =
    env.SWITCHBACK_RELEASES_API ?? 'https://api.github.com/repos/Harville-Labs/switchback/releases';
  const suffix = releasePlatform(o.platform ?? process.platform, o.arch ?? process.arch);

  const fetchOk = async (url: string, what: string) => {
    let res: Response;
    try {
      res = await get(url, { headers: { 'user-agent': `switchback/${current}` } });
    } catch (err) {
      throw new UpdateError(
        `couldn't reach ${new URL(url).host} for ${what}: ${(err as Error).message}`,
      );
    }
    if (!res.ok)
      throw new UpdateError(`couldn't download ${what} (HTTP ${res.status} from ${url}).`);
    return res;
  };

  let target = o.version?.replace(/^v/, '');
  if (!target) {
    // The newest release, prereleases included: every 0.x release is one, and
    // GitHub's "latest" skips them.
    const res = await fetchOk(`${api}?per_page=1`, 'the latest release').catch(() => {
      throw new UpdateError(
        `couldn't look up the latest release (GitHub's API allows 60 lookups an hour per address). Choose one with --version; see ${RELEASES}.`,
      );
    });
    const list = (await res.json()) as { tag_name?: string }[];
    target = list[0]?.tag_name?.replace(/^v/, '');
    if (!target) throw new UpdateError(`found no Switchback releases at ${api}.`);
  }
  if (compareVersions(target, '0.0.0') === undefined)
    throw new UpdateError(
      `"${target}" isn't a Switchback version (expected something like 0.6.0).`,
    );

  const order = compareVersions(target, current);
  if (!o.version && order !== undefined && order <= 0) {
    log(`Switchback ${current} is up to date.`);
    return 0;
  }
  if (o.check) {
    log(
      `Switchback ${target} is available (you have ${current}). Run ${bold('switchback self-update')}.`,
    );
    return 0;
  }
  if (o.version && target === current) {
    log(`Switchback ${current} is already installed.`);
    return 0;
  }

  const file = `switchback-${target}-${suffix}`;
  log(`Downloading Switchback ${target} ${dim(`(${suffix.replace(/\.exe$/, '')})`)}`);
  const sums = await (
    await fetchOk(`${base}/v${target}/SHA256SUMS`, `Switchback ${target}`).catch(() => {
      throw new UpdateError(`couldn't find Switchback ${target}. See ${RELEASES} for releases.`);
    })
  ).text();
  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === file || name === `*${file}`)?.[0];
  if (!expected) throw new UpdateError(`release ${target} lists no checksum for ${file}.`);
  const body = new Uint8Array(
    await (await fetchOk(`${base}/v${target}/${file}`, file)).arrayBuffer(),
  );
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected.toLowerCase())
    throw new UpdateError(
      `${file} doesn't match its checksum (expected ${expected}, got ${actual}). Nothing was changed; try again.`,
    );

  const dir = dirname(exe);
  const staged = join(dir, `.${basename(exe)}.${target}.new`);
  try {
    writeFileSync(staged, body, { mode: 0o755 });
    chmodSync(staged, 0o755);
  } catch (err) {
    rmSync(staged, { force: true });
    throw new UpdateError(
      `can't write to ${dir} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Run the installer instead, or update with the permissions that installed it.`,
    );
  }
  const old = join(dir, `.${basename(exe)}.old`);
  try {
    if ((o.platform ?? process.platform) === 'win32') {
      try {
        rmSync(old, { force: true });
      } catch {
        // An older engine still runs from it; renaming over it would fail too.
        throw new UpdateError(
          `${old} is still in use by a running Switchback. Close it and try again.`,
        );
      }
      renameSync(exe, old);
    }
    renameSync(staged, exe);
  } catch (err) {
    rmSync(staged, { force: true });
    throw new UpdateError(`couldn't replace ${exe}: ${(err as Error).message}`);
  }
  if ((o.platform ?? process.platform) === 'darwin') {
    // Builds aren't notarized yet; a quarantine flag would make Gatekeeper refuse them.
    spawnSync('xattr', ['-d', 'com.apple.quarantine', exe], { stdio: 'ignore' });
  }
  log(`${green('✓')} Updated Switchback ${current} → ${target} at ${exe}`);
  log(dim('Running engines keep their version until they exit; new sessions use the update.'));
  return 0;
}
