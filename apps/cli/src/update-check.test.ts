import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newerRelease, updateNotice } from './update-check.ts';

const DAY = 24 * 60 * 60 * 1000;

function releases(tag: string | Error) {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    if (tag instanceof Error) throw tag;
    return Response.json([{ tag_name: tag }]);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('newerRelease', () => {
  const now = new Date('2026-10-21T12:00:00Z');

  test('finds a release newer than the running version', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sb-update-'));
    const { fetch } = releases('v2.2.0');
    expect(await newerRelease({ dataDir, current: '2.1.0', now, fetch })).toBe('2.2.0');
  });

  test('says nothing when the running version is the newest', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sb-update-'));
    const { fetch } = releases('v2.1.0');
    expect(await newerRelease({ dataDir, current: '2.1.0', now, fetch })).toBeUndefined();
  });

  test('asks GitHub at most once a day', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sb-update-'));
    const { fetch, calls } = releases('v2.2.0');
    await newerRelease({ dataDir, current: '2.1.0', now, fetch });
    const later = new Date(now.getTime() + DAY - 1);
    expect(await newerRelease({ dataDir, current: '2.1.0', now: later, fetch })).toBe('2.2.0');
    expect(calls).toHaveLength(1);
    await newerRelease({ dataDir, current: '2.1.0', now: new Date(now.getTime() + DAY), fetch });
    expect(calls).toHaveLength(2);
  });

  test('a failed lookup keeps the last answer and waits a day to retry', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sb-update-'));
    const file = join(dataDir, 'update-check.json');
    writeFileSync(file, JSON.stringify({ checkedAt: '2026-10-01T00:00:00Z', latest: '2.2.0' }));
    const offline = releases(new Error('offline'));
    expect(await newerRelease({ dataDir, current: '2.1.0', now, fetch: offline.fetch })).toBe(
      '2.2.0',
    );
    expect(JSON.parse(readFileSync(file, 'utf8')).checkedAt).toBe(now.toISOString());
  });

  test('a damaged cache file is checked again', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'sb-update-'));
    writeFileSync(join(dataDir, 'update-check.json'), 'not json');
    const { fetch, calls } = releases('v3.0.0');
    expect(await newerRelease({ dataDir, current: '2.1.0', now, fetch })).toBe('3.0.0');
    expect(calls).toHaveLength(1);
  });
});

test('the notice names the update command', () => {
  expect(updateNotice('2.2.0', '2.1.0')).toBe(
    'Switchback 2.2.0 is out (you have 2.1.0). Update with `switchback update`.',
  );
});
