import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseEngine,
  type EngineBinary,
  installedCliPaths,
  installerShell,
  probeVersion,
} from './engine-binary.ts';

const bin = (source: EngineBinary['source'], version?: string): EngineBinary => ({
  command: source,
  args: [],
  version,
  source,
});

test('the setting always wins', () => {
  const setting = bin('setting');
  expect(
    chooseEngine({ setting, cli: bin('cli', '9.0.0'), bundled: bin('bundled', '1.0.0') }),
  ).toBe(setting);
});

test('the CLI wins when it is at least as new as the bundled engine', () => {
  const bundled = bin('bundled', '0.6.0');
  expect(chooseEngine({ cli: bin('cli', '0.6.0'), bundled })?.source).toBe('cli');
  expect(chooseEngine({ cli: bin('cli', '0.7.0'), bundled })?.source).toBe('cli');
  expect(chooseEngine({ cli: bin('cli', '0.5.9'), bundled })?.source).toBe('bundled');
  // A release candidate sorts before its release.
  expect(chooseEngine({ cli: bin('cli', '0.6.0-rc.1'), bundled })?.source).toBe('bundled');
});

test('whichever exists, or nothing', () => {
  expect(chooseEngine({ cli: bin('cli', '0.1.0') })?.source).toBe('cli');
  expect(chooseEngine({ bundled: bin('bundled', '0.1.0') })?.source).toBe('bundled');
  expect(chooseEngine({ cli: bin('cli') })).toBeUndefined();
  expect(chooseEngine({})).toBeUndefined();
});

test.if(process.platform !== 'win32')(
  'probeVersion reads a version, and nothing else',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchback-probe-'));
    try {
      const script = (name: string, body: string) => {
        const path = join(dir, name);
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
      };
      expect(await probeVersion(script('ok', 'echo 0.6.0'))).toBe('0.6.0');
      expect(await probeVersion(script('other', 'echo "usage: something else"'))).toBeUndefined();
      expect(await probeVersion(script('fails', 'exit 3'))).toBeUndefined();
      expect(await probeVersion(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('installer location and command per platform', () => {
  expect(installedCliPaths('win32', 'C:/Users/me')[0]).toEndWith('switchback.exe');
  expect(installedCliPaths('darwin', '/Users/me')[0]).toBe(
    join('/Users/me', '.local', 'bin', 'switchback'),
  );
  expect(installerShell('win32').shellArgs.join(' ')).toContain('install.ps1 | iex');
  expect(installerShell('linux').shellArgs.join(' ')).toContain('install.sh');
});
