/**
 * OS sandboxing for the bash tool, through Anthropic's sandbox runtime
 * (Seatbelt on macOS, bubblewrap and seccomp on Linux): writes only where
 * work happens, no reads of credentials, and network as configured.
 * Windows isn't sandboxed (the runtime's Windows support is alpha and needs
 * an elevated install); `mode: "on"` refuses to run commands there.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SourcedRule } from '../permissions/policy.ts';
import { parseRule } from '../permissions/rules.ts';

export interface SandboxSettings {
  /** `auto`: on where the platform supports it; `on`: refuse to run unsandboxed. */
  mode: 'auto' | 'on' | 'off';
  /** `all`, `none`, or the hosts commands may reach (`*.github.com`, `registry.npmjs.org`). */
  network: 'all' | 'none' | string[];
  /** Writable besides the workspace, temp directories, and package caches. */
  allowWrite: string[];
  /** Never readable. */
  denyRead: string[];
  /** Never writable, even inside the workspace. */
  denyWrite: string[];
  /** Whether a command may ask to run outside the sandbox (the user is always asked). */
  allowUnsandboxed: boolean;
}

/** Credentials and Switchback's own state: reading them is the main way to leak something. */
export const DEFAULT_DENY_READ = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.azure',
  '~/.kube',
  '~/.config/gcloud',
  '~/.docker/config.json',
  '~/.netrc',
];

/** Package managers' caches, so installs and builds work without asking. */
const CACHES = [
  '~/.npm',
  '~/.bun/install/cache',
  '~/.cache',
  '~/.pnpm-store',
  '~/.yarn',
  '~/.cargo/registry',
  '~/.cargo/git',
  '~/go/pkg/mod',
  '~/.gradle/caches',
  '~/.m2/repository',
  '~/Library/Caches',
];

/**
 * Files a command could use to give itself more than it was allowed: the
 * agent's own configuration, and git hooks or config that run commands
 * outside the sandbox the next time someone uses git.
 */
const PROTECTED = ['.switchback', '.claude', '.mcp.json', '.git/hooks', '.git/config'];

export interface SandboxContext {
  workspaceRoot: string;
  /** Where the command runs: the workspace, or a subagent's worktree. */
  sessionRoot: string;
  /** Switchback's config and data directories. */
  switchbackDirs: string[];
  /** Permission rules; read and edit denies apply inside the sandbox too. */
  rules: SourcedRule[];
  home?: string;
}

/** The sandbox runtime's policy for one command. */
export function sandboxPolicy(s: SandboxSettings, ctx: SandboxContext): SandboxRuntimeConfig {
  const home = ctx.home ?? homedir();
  const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p);
  const roots = [...new Set([ctx.workspaceRoot, ctx.sessionRoot])];
  const fromRules = (kind: 'read' | 'edit') =>
    ctx.rules.flatMap((r) => {
      if (r.behavior !== 'deny') return [];
      const parsed = parseRule(r.rule);
      if (parsed.target.kind !== kind || !parsed.specifier) return [];
      return roots.map((root) => rulePath(parsed.specifier as string, root, home));
    });
  return {
    filesystem: {
      denyRead: [...s.denyRead.map(expand), ...ctx.switchbackDirs, ...fromRules('read')],
      allowWrite: [...roots, tmpdir(), '/tmp', ...CACHES.map(expand), ...s.allowWrite.map(expand)],
      denyWrite: [
        ...roots.flatMap((root) => PROTECTED.map((p) => join(root, p))),
        ...s.denyWrite.map(expand),
        ...fromRules('edit'),
      ],
    },
    network: {
      allowedDomains: s.network === 'all' ? ['*'] : s.network === 'none' ? [] : s.network,
      deniedDomains: [],
      // Dev servers listen on local ports.
      allowLocalBinding: true,
    },
  };
}

/** A permission rule's path specifier as the sandbox runtime writes paths (gitignore-style to absolute). */
function rulePath(spec: string, root: string, home: string): string {
  const dir = spec.endsWith('/') ? `${spec}**` : spec;
  if (dir.startsWith('//')) return dir.slice(1);
  if (dir.startsWith('~/')) return join(home, dir.slice(2));
  const rel = dir.replace(/^\.?\//, '');
  const anchored = dir.startsWith('/') || dir.startsWith('./') || rel.includes('/');
  return anchored ? join(root, rel) : join(root, '**', rel);
}

export type SandboxState = { active: true } | { active: false; reason: string };

/**
 * The process-wide sandbox runtime (its proxies are shared by every command).
 * Prepared lazily on the first command; the policy is applied per command.
 */
export class BashSandbox {
  private ready: Promise<SandboxState> | undefined;

  constructor(private readonly dataDir: string) {}

  /** Whether commands will run sandboxed, and if not, why. */
  state(mode: SandboxSettings['mode']): Promise<SandboxState> {
    if (mode === 'off')
      return Promise.resolve({ active: false, reason: 'bash.sandbox.mode is off' });
    this.ready ??= this.start();
    return this.ready;
  }

  /** The argv and environment that run `command` inside the sandbox. */
  async wrap(
    command: string,
    shell: string,
    cwd: string,
    policy: SandboxRuntimeConfig,
    commandId: string,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
    return SandboxManager.wrapWithSandboxArgv(command, shell, policy, undefined, cwd, {
      commandId,
      commandText: command,
    });
  }

  /** stderr with what the sandbox blocked spelled out, so the model knows why a command failed. */
  explain(commandId: string, stderr: string): string {
    return SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr);
  }

  async close(): Promise<void> {
    if (this.ready) await SandboxManager.reset().catch(() => {});
    this.ready = undefined;
  }

  private async start(): Promise<SandboxState> {
    if (process.platform === 'win32')
      return { active: false, reason: 'the bash sandbox is not available on Windows' };
    if (!SandboxManager.isSupportedPlatform())
      return { active: false, reason: `the bash sandbox is not supported on ${process.platform}` };
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length) return { active: false, reason: deps.errors.join('; ') };
    const applyPath = await embeddedSeccomp(this.dataDir);
    try {
      // The base policy is the strictest; each command passes its own.
      await SandboxManager.initialize({
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        network: { allowedDomains: [], deniedDomains: [] },
        ...(applyPath ? { seccomp: { applyPath } } : {}),
      });
      return { active: true };
    } catch (err) {
      return { active: false, reason: (err as Error).message };
    }
  }
}

/**
 * In a compiled binary the runtime can't find its Linux seccomp helper next
 * to its own files, so Linux builds embed it (apps/cli/scripts/build.ts) and
 * it's written out to the data directory on first use.
 */
async function embeddedSeccomp(dataDir: string): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  const name = `apply-seccomp-${process.arch}`;
  const embedded = Bun.embeddedFiles.find((f) => (f as File).name?.startsWith(name));
  if (!embedded) return undefined;
  const path = join(dataDir, 'sandbox', name);
  if (!existsSync(path)) {
    mkdirSync(join(dataDir, 'sandbox'), { recursive: true });
    writeFileSync(path, new Uint8Array(await embedded.arrayBuffer()));
    chmodSync(path, 0o755);
  }
  return path;
}
