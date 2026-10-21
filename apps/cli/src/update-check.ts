/**
 * Whether a newer Switchback release is out, for the notice the TUI shows at
 * launch. GitHub's API allows 60 lookups an hour per address, so the answer
 * is kept for a day in Switchback's data directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { compareVersions } from '@switchback/client';

export const RELEASES_API = 'https://api.github.com/repos/Harville-Labs/switchback/releases';

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5_000;

/** From source (`bun apps/cli/src/main.ts`), process.execPath is bun itself. */
export function runFromSource(exe: string): boolean {
  return /^bun(\.exe)?$/i.test(basename(exe));
}

/**
 * The newest release's version, prereleases included: every 0.x release is
 * one, and GitHub's "latest" skips them. Throws when GitHub can't be reached
 * or refuses.
 */
export async function latestRelease(
  get: typeof fetch,
  api: string,
  current: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await get(`${api}?per_page=1`, {
    headers: { 'user-agent': `switchback/${current}` },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${api}`);
  const list = (await res.json()) as { tag_name?: string }[];
  return list[0]?.tag_name?.replace(/^v/, '');
}

export interface UpdateCheckOptions {
  dataDir: string;
  current: string;
  now: Date;
  fetch?: typeof fetch;
}

/**
 * The release newer than `current`, if there is one. Asks GitHub at most once
 * a day, failed lookups included, and never throws: a missed notice costs
 * nothing.
 */
export async function newerRelease(o: UpdateCheckOptions): Promise<string | undefined> {
  const file = join(o.dataDir, 'update-check.json');
  let checked: { checkedAt?: unknown; latest?: unknown } | undefined;
  try {
    checked = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Never checked, or the file is damaged: check now and rewrite it.
  }
  let latest = typeof checked?.latest === 'string' ? checked.latest : undefined;
  const age = o.now.getTime() - Date.parse(String(checked?.checkedAt));
  if (!(age >= 0 && age < CHECK_EVERY_MS)) {
    latest = await latestRelease(
      o.fetch ?? fetch,
      RELEASES_API,
      o.current,
      AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    ).catch(() => latest);
    try {
      mkdirSync(o.dataDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ checkedAt: o.now.toISOString(), latest }));
    } catch {
      // A read-only data directory: the next launch checks again.
    }
  }
  return latest && (compareVersions(latest, o.current) ?? 0) > 0 ? latest : undefined;
}

export function updateNotice(latest: string, current: string): string {
  return `Switchback ${latest} is out (you have ${current}). Update with \`switchback update\`.`;
}
