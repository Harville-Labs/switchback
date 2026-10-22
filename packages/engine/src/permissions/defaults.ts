/**
 * The permission rules `switchback init` writes into a new user config, and
 * the test and build presets it adds. Once written they are the user's own rules,
 * to edit like any other; nothing here applies at runtime.
 *
 * Exploring the workspace (`ls`, `grep`, `git status`, ...) needs no rule:
 * the gate lets read-only commands run under `permissions.read` (explore.ts).
 */
const ASK = [
  // Publishing work and rewriting history, even with `permissions.bash: "allow"`.
  'bash(git commit:*)',
  'bash(git push:*)',
  'bash(git rebase:*)',
  'bash(git reset* --hard*)',
  'bash(git clean:*)',
  'bash(gh pr create:*)',
  'bash(gh pr merge:*)',
  'bash(gh release:*)',
  'bash(npm publish:*)',
  'bash(pnpm publish:*)',
  'bash(yarn publish:*)',
  'bash(bun publish:*)',
  'bash(cargo publish:*)',
];

export interface DefaultPermissions {
  allow: string[];
  ask: string[];
}

/** The rules for a new user config. */
export function defaultPermissions(): DefaultPermissions {
  return { allow: [], ask: [...ASK] };
}

export interface PermissionPreset {
  id: string;
  label: string;
  allow: string[];
}

/** Test, build, and lint commands, allowed by setup. They run the project's own code. */
export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'bun',
    label: 'Bun: test, run scripts',
    allow: [
      'bash(bun test:*)',
      'bash(bun run test:*)',
      'bash(bun run lint:*)',
      'bash(bun run typecheck:*)',
      'bash(bun run build:*)',
      'bash(bun run check:*)',
    ],
  },
  {
    id: 'npm',
    label: 'npm: test, run scripts',
    allow: [
      'bash(npm test:*)',
      'bash(npm run test:*)',
      'bash(npm run lint:*)',
      'bash(npm run typecheck:*)',
      'bash(npm run build:*)',
    ],
  },
  {
    id: 'pnpm',
    label: 'pnpm: test, run scripts',
    allow: [
      'bash(pnpm test:*)',
      'bash(pnpm run test:*)',
      'bash(pnpm run lint:*)',
      'bash(pnpm run typecheck:*)',
      'bash(pnpm run build:*)',
    ],
  },
  {
    id: 'cargo',
    label: 'Cargo: check, test, build, clippy',
    allow: [
      'bash(cargo check:*)',
      'bash(cargo test:*)',
      'bash(cargo build:*)',
      'bash(cargo clippy:*)',
    ],
  },
  {
    id: 'go',
    label: 'Go: test, build, vet',
    allow: ['bash(go test:*)', 'bash(go build:*)', 'bash(go vet:*)'],
  },
  {
    id: 'python',
    label: 'Python: pytest, ruff, mypy',
    allow: ['bash(pytest:*)', 'bash(uv run pytest:*)', 'bash(ruff check:*)', 'bash(mypy:*)'],
  },
];

/**
 * The permission rules setup writes: the defaults when the user has no rules
 * yet, plus the chosen presets, added to what's there (setup never removes a
 * rule the user wrote).
 */
export function setupPermissions(
  existing: Partial<Record<'allow' | 'ask' | 'deny', string[]>>,
  presets: string[],
): DefaultPermissions | undefined {
  const fresh = !existing.allow && !existing.ask && !existing.deny;
  const base = fresh ? defaultPermissions() : { allow: [], ask: [] };
  const extra = PERMISSION_PRESETS.filter((p) => presets.includes(p.id)).flatMap((p) => p.allow);
  const allow = [...new Set([...(existing.allow ?? []), ...base.allow, ...extra])];
  const ask = [...new Set([...(existing.ask ?? []), ...base.ask])];
  if (allow.length === (existing.allow?.length ?? 0) && ask.length === (existing.ask?.length ?? 0))
    return undefined;
  return { allow, ask };
}
