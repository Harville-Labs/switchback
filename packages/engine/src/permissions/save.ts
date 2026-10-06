/** Saving allow rules chosen at a permission prompt ("always, for this project"). */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseJsonc } from '../config.ts';
import { writeConfigLayer } from '../setup.ts';

/** Add rules to a config file's `permissions.allow`, keeping what's there. */
export function saveAllowRules(file: string, rules: string[]): void {
  const existing = existsSync(file)
    ? ((parseJsonc(readFileSync(file, 'utf8')) as { permissions?: { allow?: unknown } }).permissions
        ?.allow ?? [])
    : [];
  const allow = [...new Set([...(Array.isArray(existing) ? existing : []), ...rules])];
  writeConfigLayer(file, { permissions: { allow } }, { references: false });
}

/**
 * Keep a personal file (and its backup) out of version control: add it to a
 * `.gitignore` next to it. Personal rules are the user's, not the repository's.
 */
export function ignoreInGit(file: string): void {
  const dir = dirname(file);
  const ignore = join(dir, '.gitignore');
  // The `*` also covers the `.bak` copy writeConfigLayer keeps.
  const name = `${basename(file)}*`;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(ignore)) {
    writeFileSync(ignore, `${name}\n`);
    return;
  }
  const lines = readFileSync(ignore, 'utf8').split(/\r?\n/);
  if (!lines.includes(name)) appendFileSync(ignore, `${lines.at(-1) === '' ? '' : '\n'}${name}\n`);
}
