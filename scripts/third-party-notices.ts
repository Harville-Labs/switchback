/**
 * Write THIRD-PARTY-NOTICES.txt: the license of every package bundled into the
 * `harness` binary and the VS Code extension, which releases must ship with.
 *
 *   bun scripts/third-party-notices.ts [--out dist/THIRD-PARTY-NOTICES.txt]
 *
 * The list comes from Bun.build's metafile, so it is exactly what the bundler
 * includes. License checkers that walk node_modules miss most of it under Bun's
 * hoisted workspace layout, and would also list packages that never ship.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stubReactDevtools } from '../apps/cli/scripts/stub-devtools.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

/** What ships: the CLI binary, and the extension's host and webview bundles. */
const BUILDS: Bun.BuildConfig[] = [
  { entrypoints: ['apps/cli/src/main.ts'], target: 'bun', plugins: [stubReactDevtools] },
  { entrypoints: ['apps/vscode/src/extension.ts'], target: 'node', external: ['vscode'] },
  { entrypoints: ['apps/vscode/src/webview/main.ts'], target: 'browser' },
];

export interface Notice {
  name: string;
  version: string;
  license: string;
  text: string;
}

/** `node_modules/.bun/x@1/node_modules/@scope/pkg/lib/a.js` → `node_modules/.bun/x@1/node_modules/@scope/pkg` */
export function packageRoot(input: string): string | undefined {
  const marker = 'node_modules/';
  const at = input.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = input.slice(at + marker.length).split('/');
  const name = parts[0]?.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1);
  return `${input.slice(0, at + marker.length)}${name.join('/')}`;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

function notice(dir: string): Notice {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort();
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
  const license =
    typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.[0]?.type);
  if (!license && !text)
    throw new Error(`${pkg.name}@${pkg.version} (${dir}) has no license field or file`);
  return { name: pkg.name, version: pkg.version, license: license ?? 'see text', text };
}

export async function collect(builds = BUILDS): Promise<Notice[]> {
  const dirs = new Set<string>();
  for (const config of builds) {
    const result = await Bun.build({
      ...config,
      entrypoints: config.entrypoints.map((e) => join(root, e)),
      root,
      metafile: true,
    });
    if (!result.success) throw new AggregateError(result.logs, 'bundle failed');
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      const dir = packageRoot(input);
      if (dir) dirs.add(join(root, dir));
    }
  }
  const byId = new Map<string, Notice>();
  for (const dir of dirs) {
    // Bun's metafile can name a package directory that only re-exports another.
    if (!existsSync(join(dir, 'package.json'))) continue;
    const n = notice(dir);
    byId.set(`${n.name}@${n.version}`, n);
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function render(notices: Notice[]): string {
  const head = [
    'Third-party software in Harness',
    '',
    'The harness binary and the Harness VS Code extension include the packages',
    'below. Each is used under the license that follows its name.',
    '',
  ];
  const body = notices.map((n) =>
    [
      `${'-'.repeat(78)}`,
      `${n.name} ${n.version} (${n.license})`,
      '',
      n.text || `License: ${n.license}`,
    ].join('\n'),
  );
  return `${[...head, ...body].join('\n')}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { out: { type: 'string', default: 'dist/THIRD-PARTY-NOTICES.txt' } },
  });
  const notices = await collect();
  writeFileSync(values.out, render(notices));
  console.log(`wrote ${values.out}: ${notices.length} packages`);
}
