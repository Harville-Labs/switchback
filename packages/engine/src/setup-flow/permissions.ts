/**
 * Setup: the permission rules a new user config starts with
 * (read-only commands run, commits and publishes ask), and the test and build
 * presets the user picks. Always the user config: these are the person's
 * rules, not the project's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseJsonc } from '../config.ts';
import { readCachedPolicy } from '../org/store.ts';
import { switchbackPaths } from '../paths.ts';
import { detectPresets, PERMISSION_PRESETS, setupPermissions } from '../permissions/defaults.ts';
import { writeConfigLayer } from '../setup.ts';
import type { SetupFlags } from './flags.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';

type Rules = Partial<Record<'allow' | 'ask' | 'deny', string[]>>;

export async function setupUserPermissions(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  const p = asking(ui);
  const policy = readCachedPolicy(env)?.policy;
  if (policy && !policy.restrictions.allowUserPermissions) {
    say(ui, `Command permissions are set by ${policy.org.name}.`, 'detail');
    return;
  }
  const file = switchbackPaths(env).configFile;
  const existing = existingRules(file);
  const fresh = !existing.allow && !existing.ask && !existing.deny;
  const detected = detectPresets(flags.cwd);
  let presets: string[] = [];
  if (p) {
    say(ui, 'Command permissions', 'heading');
    say(
      ui,
      fresh
        ? 'Read-only commands (ls, cat, find, grep, rg, git status, git log, git diff, ...) will run without asking. Commits, pushes, and publishes will always ask first.'
        : 'Your permission rules stay as they are; anything you pick here is added to them.',
      'detail',
    );
    say(ui, "Test and build commands run your project's code, inside the sandbox.", 'detail');
    presets = await p.multiSelect(
      'Should any test or build commands also run without asking?',
      PERMISSION_PRESETS.map((preset) => {
        const found = preset.markers.find((m) => existsSync(join(flags.cwd, m)));
        return {
          label: preset.label.split(':')[0] ?? preset.label,
          value: preset.id,
          hint: `${presetCommands(preset.allow)}${found ? `  · found ${found}` : ''}`,
          checked: detected.includes(preset.id),
        };
      }),
    );
  }
  const next = setupPermissions(existing, presets);
  if (!next) {
    say(ui, 'Nothing to add.', 'detail');
    return;
  }
  writeConfigLayer(file, { permissions: next }, { references: false });
  const picked = PERMISSION_PRESETS.filter((x) => presets.includes(x.id)).map(
    (x) => x.label.split(':')[0],
  );
  const parts = [
    ...(fresh ? ['read-only commands'] : []),
    ...picked.map((name) => `${name} test and build commands`),
  ];
  const runs =
    parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
  say(
    ui,
    `Saved to ${tildify(file)}: ${runs} run without asking${fresh ? '; commits, pushes, and publishes ask first' : ''}.`,
    'success',
  );
  say(ui, 'Change them in that file any time; /permissions shows what is in effect.', 'detail');
}

/** A preset's rules as the commands they allow: `bun test, bun run test/lint/build`. */
export function presetCommands(allow: string[]): string {
  const commands = allow.map((r) => r.replace(/^bash\(/, '').replace(/(:\*)?\)$/, ''));
  const groups = new Map<string, string[]>();
  for (const c of commands) {
    const words = c.split(' ');
    // `bun run test`, `bun run lint` share `bun run`; group them by everything but the last word.
    const head = words.length > 2 ? words.slice(0, -1).join(' ') : c;
    const tail = words.length > 2 ? (words.at(-1) as string) : '';
    groups.set(head, [...(groups.get(head) ?? []), ...(tail ? [tail] : [])]);
  }
  return [...groups]
    .map(([head, tails]) => (tails.length ? `${head} ${tails.join('/')}` : head))
    .join(', ');
}

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function existingRules(file: string): Rules {
  if (!existsSync(file)) return {};
  const cfg = parseJsonc(readFileSync(file, 'utf8')) as { permissions?: Rules };
  return cfg.permissions ?? {};
}
