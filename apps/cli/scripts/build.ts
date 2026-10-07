/**
 * Compile the `switchback` single-file executable.
 *
 *   bun apps/cli/scripts/build.ts [--target bun-darwin-arm64] [--outfile dist/switchback]
 */

import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stubReactDevtools } from './stub-devtools.ts';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: 'string' },
    outfile: { type: 'string', default: 'dist/switchback' },
  },
});

/** The sandbox runtime package the engine depends on. */
function sandboxRuntime(): string {
  const engine = createRequire(
    fileURLToPath(new URL('../../../packages/engine/package.json', import.meta.url)),
  );
  return dirname(engine.resolve('@anthropic-ai/sandbox-runtime/package.json'));
}

/**
 * Linux builds embed the sandbox runtime's seccomp helper for their
 * architecture, which the engine writes out on first use (tools/sandbox.ts).
 */
function seccompHelper(): string[] {
  const target = values.target ?? `bun-${process.platform}-${process.arch}`;
  const arch = /^bun-linux-(x64|arm64)/.exec(target)?.[1];
  if (!arch) return [];
  const runtime = sandboxRuntime();
  // Its embedded name is how the engine finds it.
  const copy = join(mkdtempSync(join(tmpdir(), 'switchback-build-')), `apply-seccomp-${arch}`);
  copyFileSync(join(runtime, 'vendor', 'seccomp', arch, 'apply-seccomp'), copy);
  return [copy];
}

/**
 * Windows builds embed the sandbox runtime's `srt-win.exe` helper, which the
 * engine copies into the data directory on first use (tools/sandbox.ts).
 */
function windowsHelper(): string[] {
  const target = values.target ?? `bun-${process.platform}-${process.arch}`;
  const arch = /^bun-windows-(x64|arm64)/.exec(target)?.[1];
  if (!arch) return [];
  const copy = join(mkdtempSync(join(tmpdir(), 'switchback-build-')), `srt-win-${arch}.exe`);
  copyFileSync(join(sandboxRuntime(), 'vendor', 'srt-win', arch, 'srt-win.exe'), copy);
  return [copy];
}

const result = await Bun.build({
  entrypoints: [
    fileURLToPath(new URL('../src/main.ts', import.meta.url)),
    ...seccompHelper(),
    ...windowsHelper(),
  ],
  compile: {
    outfile: values.outfile,
    ...(values.target ? { target: values.target as Bun.Build.CompileTarget } : {}),
  },
  // Keep identifiers so customer stack traces stay readable without shipping sourcemaps.
  minify: { whitespace: true, syntax: true, identifiers: false },
  plugins: [stubReactDevtools],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${values.outfile}`);
