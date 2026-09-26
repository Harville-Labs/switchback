/**
 * Release helpers. The CLI, engine, and VS Code extension always share one version.
 *
 *   bun scripts/release.ts prepare 0.2.0   bump every version and cut the changelog section
 *   bun scripts/release.ts verify v0.2.0   CI: fail unless everything matches the tag
 *   bun scripts/release.ts notes 0.2.0     print the changelog section (release notes)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const file = (p: string) => `${root}${p}`;

/** Every place a version string lives, with how to read and write it. */
export const VERSION_SITES = [
  { path: 'apps/cli/package.json', pattern: /("version":\s*")([^"]+)(")/ },
  { path: 'apps/vscode/package.json', pattern: /("version":\s*")([^"]+)(")/ },
  { path: 'packages/engine/src/engine.ts', pattern: /(ENGINE_VERSION = ')([^']+)(')/ },
  { path: 'apps/vscode/src/extension.ts', pattern: /(const VERSION = ')([^']+)(')/ },
] as const;

export function readVersions(): Record<string, string> {
  return Object.fromEntries(
    VERSION_SITES.map((s) => [
      s.path,
      s.pattern.exec(readFileSync(file(s.path), 'utf8'))?.[2] ?? '(missing)',
    ]),
  );
}

export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** Move the Unreleased notes under a new version heading. */
export function cutChangelog(changelog: string, version: string, date: string): string {
  const marker = '## [Unreleased]';
  const i = changelog.indexOf(marker);
  if (i === -1) throw new Error('CHANGELOG.md has no [Unreleased] section');
  const after = i + marker.length;
  return `${changelog.slice(0, after)}\n\n## [${version}] - ${date}${changelog.slice(after)}`;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function main(argv: string[]): number {
  const [command, arg] = argv;
  switch (command) {
    case 'prepare': {
      if (!arg || !SEMVER.test(arg)) throw new Error('usage: prepare <semver>');
      for (const s of VERSION_SITES) {
        const text = readFileSync(file(s.path), 'utf8');
        writeFileSync(file(s.path), text.replace(s.pattern, `$1${arg}$3`));
      }
      const changelog = readFileSync(file('CHANGELOG.md'), 'utf8');
      if (!changelogSection(changelog, arg)) {
        const date = new Date().toISOString().slice(0, 10);
        writeFileSync(file('CHANGELOG.md'), cutChangelog(changelog, arg, date));
      }
      console.log(`prepared ${arg}; review CHANGELOG.md, commit, then tag v${arg}`);
      return 0;
    }
    case 'verify': {
      const version = arg?.replace(/^v/, '');
      if (!version || !SEMVER.test(version)) throw new Error('usage: verify <tag>');
      const versions = readVersions();
      const wrong = Object.entries(versions).filter(([, v]) => v !== version);
      for (const [path, v] of wrong) console.error(`${path}: ${v}, expected ${version}`);
      const notes = changelogSection(readFileSync(file('CHANGELOG.md'), 'utf8'), version);
      if (!notes) console.error(`CHANGELOG.md has no entry for [${version}]`);
      if (wrong.length || !notes) return 1;
      console.log(`v${version} verified`);
      return 0;
    }
    case 'notes': {
      const notes = changelogSection(readFileSync(file('CHANGELOG.md'), 'utf8'), arg ?? '');
      if (!notes) throw new Error(`no changelog entry for ${arg}`);
      console.log(notes);
      return 0;
    }
    default:
      console.error('usage: release.ts prepare <version> | verify <tag> | notes <version>');
      return 2;
  }
}

if (import.meta.main) process.exit(main(Bun.argv.slice(2)));
