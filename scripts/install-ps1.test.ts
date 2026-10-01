import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs scripts/install.ps1 against a local server laid out like GitHub, on Windows
 * only, with both PowerShell 7 (pwsh) and Windows PowerShell 5.1 (powershell).
 * The fake releases are real executables that print their version, because the
 * installer runs `switchback.exe --version` to check the install.
 */
const SCRIPT = fileURLToPath(new URL('./install.ps1', import.meta.url));
const windows = process.platform === 'win32';
const shells = windows ? ['pwsh', 'powershell'].filter((s) => Bun.which(s)) : [];

const sha = (body: Buffer<ArrayBuffer> | string) => createHash('sha256').update(body).digest('hex');

let server: ReturnType<typeof Bun.serve>;
let root: string;
const releases: Record<string, Record<string, Buffer<ArrayBuffer> | string>> = {};

async function fakeBinary(version: string): Promise<Buffer<ArrayBuffer>> {
  const src = join(root, `fake-${version}.ts`);
  const out = join(root, `fake-${version}.exe`);
  writeFileSync(src, `console.log(${JSON.stringify(version)});\n`);
  const build = Bun.spawnSync(['bun', 'build', '--compile', src, '--outfile', out]);
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  return readFileSync(out);
}

function release(version: string, bin: Buffer<ArrayBuffer>, tamper = false) {
  const files: Record<string, Buffer<ArrayBuffer> | string> = {
    [`switchback-${version}-windows-x64.exe`]: bin,
    [`switchback-vscode-${version}-win32-x64.vsix`]: 'fake vsix',
  };
  const sums = Object.entries(files)
    .map(([name, body]) => `${tamper ? sha(`${name}!`) : sha(body)}  ${name}`)
    .join('\n');
  return { ...files, SHA256SUMS: `${sums}\n` };
}

beforeAll(async () => {
  if (!shells.length) return;
  // The long path: tmpdir() can be an 8.3 short name, which the installer expands.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'switchback-install-ps1-')));
  const v123 = await fakeBinary('1.2.3');
  const v100 = await fakeBinary('1.0.0');
  releases['v1.2.3'] = release('1.2.3', v123);
  releases['v1.0.0'] = release('1.0.0', v100);
  releases['v0.9.0'] = release('0.9.0', v100, true);
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
}, 120_000);
afterAll(() => {
  server?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

let n = 0;
async function run(
  shell: string,
  args: string[],
  extraPath?: string,
  dir = join(root, `bin-${n++}`),
) {
  const proc = Bun.spawn(
    [shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Dir', dir, ...args],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // Windows names it Path; setting PATH alongside would leave two entries.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'),
        ),
        Path: extraPath ? `${extraPath};${process.env.PATH}` : (process.env.PATH ?? ''),
        SWITCHBACK_DOWNLOAD_URL: `http://localhost:${server.port}/download`,
        SWITCHBACK_RELEASES_API: `http://localhost:${server.port}/releases`,
      },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { dir, code, out, err };
}

const installed = (dir: string) => join(dir, 'switchback.exe');

for (const shell of shells) {
  describe(`install.ps1 (${shell})`, () => {
    test('installs the newest release, prereleases included', async () => {
      const r = await run(shell, ['-NoModifyPath']);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Installed Switchback 1.2.3 to ${installed(r.dir)}`);
      expect(r.out).toContain("isn't on your PATH");
      expect(r.out).toContain('switchback init');
    }, 60_000);

    test('installs a pinned version, with or without the v', async () => {
      for (const version of ['v1.0.0', '1.0.0']) {
        const r = await run(shell, ['-NoModifyPath', '-Version', version]);
        expect(r.code).toBe(0);
        expect(r.out).toContain('Installed Switchback 1.0.0');
      }
    }, 60_000);

    test('refuses a download that fails its checksum and installs nothing', async () => {
      const r = await run(shell, ['-NoModifyPath', '-Version', '0.9.0']);
      expect(r.code).toBe(1);
      expect(r.err).toContain("doesn't match its checksum");
      expect(existsSync(installed(r.dir))).toBe(false);
    }, 60_000);

    test('says so when a version does not exist', async () => {
      const r = await run(shell, ['-NoModifyPath', '-Version', '4.5.6']);
      expect(r.code).toBe(1);
      expect(r.err).toContain("couldn't find Switchback 4.5.6");
    }, 60_000);

    test('rejects nonsense versions and options', async () => {
      const bad = await run(shell, ['-Version', 'banana']);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("isn't a Switchback version");
      const unknown = await run(shell, ['-Frobnicate']);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('Frobnicate');
    }, 60_000);

    test('-VSCode installs the extension with the code command', async () => {
      const fake = join(root, `editor-${n}`);
      mkdirSync(fake, { recursive: true });
      const log = join(fake, 'calls');
      writeFileSync(join(fake, 'code.cmd'), `@echo %* > "${log}"\r\n`);
      const r = await run(shell, ['-NoModifyPath', '-VSCode'], fake);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Installed the extension in code');
      expect(readFileSync(log, 'utf8')).toMatch(
        /--install-extension .*switchback-vscode-1\.2\.3-win32-x64\.vsix --force/,
      );
    }, 60_000);
  });
}

// Changes the real user PATH in the registry, so it runs once and restores it.
describe.if(shells.length > 0)('install.ps1 user PATH', () => {
  const reg = (script: string) =>
    Bun.spawnSync([shells[0] ?? 'pwsh', '-NoProfile', '-Command', script]).stdout.toString();
  const readRaw = `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $k.GetValueKind('Path')`;

  test('adds the directory once, keeping %VARIABLES% unexpanded', async () => {
    const before = reg(readRaw);
    const marker = '%SWITCHBACK_TEST_VAR%\\bin';
    reg(
      `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $p = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $k.SetValue('Path', "$p;${marker}", 'ExpandString')`,
    );
    try {
      const r = await run(shells[0] ?? 'pwsh', []);
      expect(r.code).toBe(0);
      expect(r.out).toContain('to your user PATH');
      const after = reg(readRaw);
      expect(after).toContain(marker);
      expect(after).toContain(r.dir);
      expect(after.trim().endsWith('ExpandString')).toBe(true);
      const again = await run(shells[0] ?? 'pwsh', [], undefined, r.dir);
      expect(again.out).not.toContain('to your user PATH');
    } finally {
      const [path] = before.trimEnd().split(/\r?\n/);
      reg(
        `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', '${(path ?? '').replaceAll("'", "''")}', 'ExpandString')`,
      );
    }
  }, 120_000);
});
