/**
 * Compile the `harness` single-file executable.
 *
 *   bun apps/cli/scripts/build.ts [--target bun-darwin-arm64] [--outfile dist/harness]
 *
 * Ink optionally imports react-devtools-core when DEV=true. Bun hoists external
 * imports to the top of a compiled bundle, which would make every run fail, so
 * we replace the module with an empty stub instead.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    target: { type: 'string' },
    outfile: { type: 'string', default: 'dist/harness' },
  },
});

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  compile: {
    outfile: values.outfile,
    ...(values.target ? { target: values.target as Bun.Build.CompileTarget } : {}),
  },
  minify: true,
  sourcemap: 'linked',
  plugins: [
    {
      name: 'stub-react-devtools',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default { initialize() {}, connectToDevTools() {} };',
          loader: 'js',
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${values.outfile}`);
