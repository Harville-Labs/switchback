import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasePlatform, selfUpdate } from './self-update.ts';

/** A server laid out like GitHub: /download/<tag>/<file> and the releases API at /releases. */
const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const binary = (v: string) => `binary ${v}`;
function release(version: string, tamper = false) {
  const names = [`switchback-${version}-linux-x64`, `switchback-${version}-windows-x64.exe`];
  const sum = sha(tamper ? 'tampered' : binary(version));
  return {
    ...Object.fromEntries(names.map((name) => [name, binary(version)])),
    SHA256SUMS: names.map((name) => `${sum}  ${name}\n`).join(''),
  };
}
const releases: Record<string, Record<string, string>> = {
  'v0.7.0': release('0.7.0'),
  'v0.5.0': release('0.5.0'),
  'v0.4.0': release('0.4.0', true),
};

let server: ReturnType<typeof Bun.serve>;
let root: string;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/releases') return Response.json([{ tag_name: 'v0.7.0' }]);
      const [, , tag, file] = url.pathname.split('/');
      const body = releases[tag ?? '']?.[file ?? ''];
      return body ? new Response(body) : new Response('Not found', { status: 404 });
    },
  });
  root = mkdtempSync(join(tmpdir(), 'switchback-self-update-'));
});
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** An installed binary at version `current`, and a run of self-update against it. */
async function run(
  current: string,
  opts: { version?: string; check?: boolean; platform?: NodeJS.Platform } = {},
) {
  const dir = join(root, `bin-${n++}`);
  mkdirSync(dir);
  const exePath = join(dir, 'switchback');
  writeFileSync(exePath, binary(current));
  const lines: string[] = [];
  const code = await selfUpdate({
    ...opts,
    exePath,
    currentVersion: current,
    platform: opts.platform ?? 'linux',
    arch: 'x64',
    env: {
      SWITCHBACK_DOWNLOAD_URL: `http://localhost:${server.port}/download`,
      SWITCHBACK_RELEASES_API: `http://localhost:${server.port}/releases`,
    },
    log: (l) => lines.push(l),
  });
  return { code, out: lines.join('\n'), dir, exePath, installed: readFileSync(exePath, 'utf8') };
}

test('updates to the newest release, verified, in place', async () => {
  const r = await run('0.6.0');
  expect(r.code).toBe(0);
  expect(r.installed).toBe(binary('0.7.0'));
  expect(r.out).toContain('Updated Switchback 0.6.0 → 0.7.0');
  // Nothing staged is left behind.
  expect(readdirSync(r.dir)).toEqual(['switchback']);
});

test('says so when already up to date, and --check only reports', async () => {
  const same = await run('0.7.0');
  expect(same.out).toContain('0.7.0 is up to date');
  expect(same.installed).toBe(binary('0.7.0'));
  const check = await run('0.6.0', { check: true });
  expect(check.out).toContain('Switchback 0.7.0 is available (you have 0.6.0)');
  expect(check.installed).toBe(binary('0.6.0'));
});

test('installs a chosen version, including an older one', async () => {
  const r = await run('0.6.0', { version: 'v0.5.0' });
  expect(r.code).toBe(0);
  expect(r.installed).toBe(binary('0.5.0'));
});

test('a download that fails its checksum changes nothing', async () => {
  const r = await run('0.6.0', { version: '0.4.0' });
  expect(r.code).toBe(1);
  expect(r.installed).toBe(binary('0.6.0'));
  expect(readdirSync(r.dir)).toEqual(['switchback']);
});

test('a missing or nonsense version is an error', async () => {
  expect((await run('0.6.0', { version: '9.9.9' })).code).toBe(1);
  expect((await run('0.6.0', { version: 'banana' })).code).toBe(1);
});

test('Windows: the running binary steps aside, and the next run clears it', async () => {
  const r = await run('0.6.0', { platform: 'win32' });
  expect(r.code).toBe(0);
  expect(r.installed).toBe(binary('0.7.0'));
  expect(existsSync(join(r.dir, '.switchback.old'))).toBe(true);
  const again = await selfUpdate({
    exePath: r.exePath,
    currentVersion: '0.7.0',
    platform: 'win32',
    arch: 'x64',
    env: { SWITCHBACK_RELEASES_API: `http://localhost:${server.port}/releases` },
    log: () => {},
  });
  expect(again).toBe(0);
  expect(existsSync(join(r.dir, '.switchback.old'))).toBe(false);
});

test('release asset names per platform', () => {
  expect(releasePlatform('linux', 'arm64')).toBe('linux-arm64');
  expect(releasePlatform('win32', 'arm64')).toBe('windows-x64.exe');
  expect(() => releasePlatform('freebsd', 'x64')).toThrow('no build for freebsd-x64');
});
