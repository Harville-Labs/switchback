/**
 * Compile the `switchback` single-file executable.
 *
 *   bun apps/cli/scripts/build.ts [--target bun-darwin-arm64] [--outfile dist/switchback]
 */
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

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
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
