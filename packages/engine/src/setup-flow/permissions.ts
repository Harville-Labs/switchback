/**
 * Setup: the permission rules a new user config starts with
 * (read-only commands run, commits and publishes ask), plus every test and
 * build preset. Always the user config: these are the person's
 * rules, not the project's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseJsonc } from '../config.ts';
import { readCachedPolicy } from '../org/store.ts';
import { switchbackPaths, tildify } from '../paths.ts';
import { PERMISSION_PRESETS, setupPermissions } from '../permissions/defaults.ts';
import { writeConfigLayer } from '../setup.ts';
import type { ImportedPermissions } from './from-opencode.ts';
import { type SetupPrompter, say } from './prompter.ts';

type Rules = Partial<Record<'allow' | 'ask' | 'deny', string[]>>;

export async function setupUserPermissions(
  ui: SetupPrompter | undefined,
  env: Record<string, string | undefined> = process.env,
  /** Levels and rules from another agent's setup, added to what's written. */
  imported?: ImportedPermissions,
) {
  const policy = readCachedPolicy(env)?.policy;
  if (policy && !policy.restrictions.allowUserPermissions) {
    say(ui, `Command permissions are set by ${policy.org.name}.`, 'detail');
    return;
  }
  const file = switchbackPaths(env).configFile;
  const existing = existingRules(file);
  const fresh = !existing.allow && !existing.ask && !existing.deny;
  // Test and build commands run the project's code inside the sandbox, so setup allows them all.
  const presets = PERMISSION_PRESETS.map((x) => x.id);
  const next = withImported(setupPermissions(existing, presets), existing, imported);
  if (!next) {
    say(ui, 'Nothing to add.', 'detail');
    return;
  }
  writeConfigLayer(file, { permissions: next }, { references: false });
  const parts = [
    ...(fresh ? ['test and build commands'] : []),
    ...(imported?.allow.length ? ['what your previous agent allowed'] : []),
  ];
  const runs =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  say(
    ui,
    runs
      ? `Saved to ${tildify(file)}: ${runs} run without asking${fresh ? '; commits, pushes, and publishes ask first' : ''}.`
      : `Saved permission rules to ${tildify(file)}.`,
    'success',
  );
  say(ui, 'Change them in that file any time; /permissions shows what is in effect.', 'detail');
}

/** Imported levels, and imported rules added to the lists (rules are never removed). */
function withImported(
  next: Rules | undefined,
  existing: Rules,
  imported: ImportedPermissions | undefined,
): Record<string, unknown> | undefined {
  if (!imported) return next;
  const list = (k: 'allow' | 'ask' | 'deny') => [
    ...new Set([...(next?.[k] ?? existing[k] ?? []), ...imported[k]]),
  ];
  const deny = list('deny');
  return {
    ...imported.levels,
    ...(imported.outsideWorkspace ? { outsideWorkspace: imported.outsideWorkspace } : {}),
    allow: list('allow'),
    ask: list('ask'),
    ...(deny.length ? { deny } : {}),
  };
}

function existingRules(file: string): Rules {
  if (!existsSync(file)) return {};
  const cfg = parseJsonc(readFileSync(file, 'utf8')) as { permissions?: Rules };
  return cfg.permissions ?? {};
}
