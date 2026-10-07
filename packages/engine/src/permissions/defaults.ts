/**
 * The permission rules `switchback init` writes into a new user config, and
 * the opt-in presets it offers. Once written they are the user's own rules,
 * to edit like any other; nothing here applies at runtime.
 *
 * Allows name exact commands or prefixes, never a tool with a subcommand or
 * flag that writes or runs other programs; those flags get an ask rule
 * instead, which beats the allow (`find -exec`, `rg --pre`, `git log --output`).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only commands: exploring the workspace and the repository's history. */
const EXPLORE = [
  'bash(ls:*)',
  'bash(pwd)',
  'bash(cat:*)',
  'bash(head:*)',
  'bash(tail:*)',
  'bash(wc:*)',
  'bash(stat:*)',
  'bash(du:*)',
  'bash(diff:*)',
  'bash(which:*)',
  'bash(find:*)',
  'bash(grep:*)',
  'bash(egrep:*)',
  'bash(fgrep:*)',
  'bash(rg:*)',
  'bash(git status:*)',
  'bash(git log:*)',
  'bash(git diff:*)',
  'bash(git show:*)',
  'bash(git blame:*)',
  'bash(git ls-files:*)',
  'bash(git rev-parse:*)',
  'bash(git describe:*)',
  'bash(git shortlog:*)',
  'bash(git branch)',
  'bash(git branch --show-current)',
  'bash(git branch -a)',
  'bash(git branch -v)',
  'bash(git remote -v)',
  'bash(git stash list:*)',
];

const ASK = [
  // Options that turn an allowed read into a write or another program.
  'bash(find* -exec*)',
  'bash(find* -ok*)',
  'bash(find* -delete*)',
  'bash(find* -fprint*)',
  'bash(find* -fls*)',
  'bash(rg* --pre*)',
  'bash(git* --output*)',
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
  return { allow: [...EXPLORE], ask: [...ASK] };
}

export interface PermissionPreset {
  id: string;
  label: string;
  /** Files at the workspace root that suggest the preset. */
  markers: string[];
  allow: string[];
}

/** Test, build, and lint commands, offered during setup. They run the project's own code. */
export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: 'bun',
    label: 'Bun: test, run scripts',
    markers: ['bun.lock', 'bun.lockb'],
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
    markers: ['package-lock.json'],
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
    markers: ['pnpm-lock.yaml'],
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
    markers: ['Cargo.toml'],
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
    markers: ['go.mod'],
    allow: ['bash(go test:*)', 'bash(go build:*)', 'bash(go vet:*)'],
  },
  {
    id: 'python',
    label: 'Python: pytest, ruff, mypy',
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    allow: ['bash(pytest:*)', 'bash(uv run pytest:*)', 'bash(ruff check:*)', 'bash(mypy:*)'],
  },
];

/** The presets a workspace's files point to. */
export function detectPresets(root: string): string[] {
  return PERMISSION_PRESETS.filter((p) => p.markers.some((m) => existsSync(join(root, m)))).map(
    (p) => p.id,
  );
}

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
