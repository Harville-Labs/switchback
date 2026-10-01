import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs scripts/install.sh against a local server laid out like GitHub:
 * release files at /download/<tag>/<file> and the releases API at /releases.
 */
const SCRIPT = fileURLToPath(new URL('./install.sh', import.meta.url));
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const supported = process.platform === 'darwin' || process.platform === 'linux';
const shells = ['sh', ...(Bun.which('dash') ? ['dash'] : [])];

const sha = (body: string) => createHash('sha256').update(body).digest('hex');
const binary = (version: string) => `#!/bin/sh\necho ${version}\n`;

function release(version: string, tamper = false) {
  const bin = `switchback-${version}-${OS}-${ARCH}`;
  const vsix = `switchback-vscode-${version}-${OS}-${ARCH}.vsix`;
  const files: Record<string, string> = { [bin]: binary(version), [vsix]: 'fake vsix' };
  const sums = Object.entries(files)
    .map(([name, body]) => `${sha(tamper ? `${body}!` : body)}  ${name}`)
    .join('\n');
  return { ...files, SHA256SUMS: `${sums}\n` };
}

const releases: Record<string, Record<string, string>> = {
  'v1.2.3': release('1.2.3'),
  'v1.0.0': release('1.0.0'),
  'v0.9.0': release('0.9.0', true),
};

let server: ReturnType<typeof Bun.serve>;
let root: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/releases')
        return Response.json([{ tag_name: 'v1.2.3', prerelease: true }, { tag_name: 'v1.0.0' }]);
      const [, , tag, file] = url.pathname.split('/');
      const body = releases[tag ?? '']?.[file ?? ''];
      return body ? new Response(body) : new Response('Not found', { status: 404 });
    },
  });
  root = mkdtempSync(join(tmpdir(), 'switchback-install-'));
});
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
/** Async: a synchronous spawn would block the server this process is running. */
async function run(shell: string, args: string[], extraPath?: string) {
  const dir = join(root, `bin-${n++}`);
  const proc = Bun.spawn([shell, SCRIPT, '--dir', dir, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      HOME: root,
      SHELL: '/bin/zsh',
      PATH: extraPath ? `${extraPath}:${process.env.PATH}` : (process.env.PATH ?? ''),
      SWITCHBACK_DOWNLOAD_URL: `http://localhost:${server.port}/download`,
      SWITCHBACK_RELEASES_API: `http://localhost:${server.port}/releases`,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { dir, code, out, err };
}

for (const shell of shells) {
  describe.if(supported)(`install.sh (${shell})`, () => {
    test('installs the newest release, prereleases included, and explains PATH', async () => {
      const r = await run(shell, []);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(readFileSync(join(r.dir, 'switchback'), 'utf8')).toBe(binary('1.2.3'));
      expect(r.out).toContain(`Installed Switchback 1.2.3 to ${r.dir}/switchback`);
      expect(r.out).toContain(`echo 'export PATH="${r.dir}:$PATH"' >> ~/.zshrc`);
      expect(r.out).toContain('switchback init');
    });

    test('installs a pinned version, with or without the v', async () => {
      for (const args of [['--version', 'v1.0.0'], ['--version=1.0.0']]) {
        const r = await run(shell, args);
        expect(readFileSync(join(r.dir, 'switchback'), 'utf8')).toBe(binary('1.0.0'));
      }
    });

    test('refuses a download that fails its checksum and installs nothing', async () => {
      const r = await run(shell, ['--version', '0.9.0']);
      expect(r.code).toBe(1);
      expect(r.err).toContain("doesn't match its checksum");
      expect(existsSync(join(r.dir, 'switchback'))).toBe(false);
    });

    test('says so when a version does not exist', async () => {
      const r = await run(shell, ['--version', '4.5.6']);
      expect(r.code).toBe(1);
      expect(r.err).toContain("couldn't find Switchback 4.5.6");
    });

    test('rejects nonsense versions and options', async () => {
      expect((await run(shell, ['--version', 'banana'])).err).toContain(
        "isn't a Switchback version",
      );
      expect((await run(shell, ['--frobnicate'])).err).toContain('unknown option --frobnicate');
    });

    test('--vscode installs the extension with the code command', async () => {
      const fake = join(root, `editor-${n}`);
      mkdirSync(fake, { recursive: true });
      const log = join(fake, 'calls');
      writeFileSync(join(fake, 'code'), `#!/bin/sh\necho "$@" > "${log}"\n`);
      chmodSync(join(fake, 'code'), 0o755);
      const r = await run(shell, ['--vscode'], fake);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Installed the extension in code.');
      expect(readFileSync(log, 'utf8')).toMatch(
        new RegExp(
          `--install-extension .*switchback-vscode-1\\.2\\.3-${OS}-${ARCH}\\.vsix --force`,
        ),
      );
    });
  });
}
