/**
 * `switchback init`: the permission rules a new user config starts with
 * (read-only commands run, commits and publishes ask), and the test and build
 * presets the user picks. Always the user config: these are the person's
 * rules, not the project's.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  detectPresets,
  PERMISSION_PRESETS,
  parseJsonc,
  readCachedPolicy,
  setupPermissions,
  switchbackPaths,
  writeConfigLayer,
} from '@switchback/engine';
import { dim, green, type Prompter } from '../prompt.ts';
import type { InitFlags } from './init-flags.ts';

type Rules = Partial<Record<'allow' | 'ask' | 'deny', string[]>>;

export async function setupUserPermissions(flags: InitFlags, p: Prompter | undefined) {
  const policy = readCachedPolicy()?.policy;
  if (policy && !policy.restrictions.allowUserPermissions) {
    if (p) console.log(dim(`Permissions are set by ${policy.org.name}.\n`));
    return;
  }
  const file = switchbackPaths().configFile;
  const detected = detectPresets(flags.cwd);
  const presets = p
    ? await p.multiSelect(
        "Also run these without asking? They run your project's own code, inside the sandbox.",
        PERMISSION_PRESETS.map((preset) => ({
          label: preset.label,
          value: preset.id,
          checked: detected.includes(preset.id),
        })),
      )
    : [];
  const existing = existingRules(file);
  const next = setupPermissions(existing, presets);
  if (!next) return;
  writeConfigLayer(file, { permissions: next }, { references: false });
  const added = next.allow.length - (existing.allow?.length ?? 0);
  const asks = next.ask.length - (existing.ask?.length ?? 0);
  console.log(
    `${green('✓')} Permissions in ${file}: ${added} command rules run without asking${asks ? `, ${asks} ask first (commits, pushes, publishes)` : ''}. Edit them there; /permissions lists them.`,
  );
  console.log();
}

function existingRules(file: string): Rules {
  if (!existsSync(file)) return {};
  const cfg = parseJsonc(readFileSync(file, 'utf8')) as { permissions?: Rules };
  return cfg.permissions ?? {};
}
