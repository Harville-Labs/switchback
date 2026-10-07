/**
 * OS sandboxing for the bash tool, through Anthropic's sandbox runtime
 * (Seatbelt on macOS, bubblewrap and seccomp on Linux, a separate sandbox
 * account with ACLs and a network filter on Windows): writes only where work
 * happens, no reads of credentials, and network as configured.
 *
 * Windows needs a one-time elevated install (`switchback sandbox install`),
 * and grants writes once, when the sandbox starts: a command can only add
 * denies. So its write grants cover the workspace and every subagent
 * worktree from the start, and take config changes at the next restart.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkWindowsDependenciesAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
  SandboxManager,
  type SandboxRuntimeConfig,
  uninstallWindowsSandbox,
  VENDORED_SRT_WIN_EXE,
} from '@anthropic-ai/sandbox-runtime';
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
const PROTECTED = ['.switchback', '.git/hooks', '.git/config'];

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

/** No writes, no network: the base each command's own policy widens. */
const STRICT: SandboxRuntimeConfig = {
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  network: { allowedDomains: [], deniedDomains: [] },
};

export type SandboxState = { active: true } | { active: false; reason: string };

/**
 * The process-wide sandbox runtime (its proxies are shared by every command).
 * Prepared lazily on the first command; the policy is applied per command.
 */
export class BashSandbox {
  private ready: Promise<SandboxState> | undefined;

  constructor(
    private readonly dataDir: string,
    /** The policy for every command, which Windows needs up front. */
    private readonly session?: () => SandboxRuntimeConfig,
  ) {}

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
    // Windows granted the writes when it started; a command may only add denies.
    const own = process.platform === 'win32' ? withoutGrants(policy) : policy;
    return SandboxManager.wrapWithSandboxArgv(command, shell, own, undefined, cwd, {
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

  private async startWindows(): Promise<SandboxState> {
    const path = await srtWinPath(this.dataDir);
    if (!path) return { active: false, reason: "this build doesn't include the Windows sandbox" };
    const srtWin = resolveSrtWin({ path });
    const deps = await checkWindowsDependenciesAsync({ srtWin });
    if (deps.errors.length) return { active: false, reason: INSTALL_HINT };
    try {
      await SandboxManager.initialize({
        ...(this.session?.() ?? STRICT),
        windows: { srtWin: { path } },
      });
      return { active: true };
    } catch (err) {
      return { active: false, reason: (err as Error).message };
    }
  }

  private async start(): Promise<SandboxState> {
    if (process.platform === 'win32') return this.startWindows();
    if (!SandboxManager.isSupportedPlatform())
      return { active: false, reason: `the bash sandbox is not supported on ${process.platform}` };
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length) return { active: false, reason: deps.errors.join('; ') };
    const applyPath = await embeddedSeccomp(this.dataDir);
    try {
      // The base policy is the strictest; each command passes its own.
      await SandboxManager.initialize({
        ...STRICT,
        ...(applyPath ? { seccomp: { applyPath } } : {}),
      });
      return { active: true };
    } catch (err) {
      return { active: false, reason: (err as Error).message };
    }
  }
}

/** The same policy without its grants, which Windows applies only at startup. */
function withoutGrants(policy: SandboxRuntimeConfig): SandboxRuntimeConfig {
  return { ...policy, filesystem: { ...policy.filesystem, allowWrite: [] } };
}

const INSTALL_HINT =
  'the Windows sandbox is not set up; run `switchback sandbox install` (one administrator prompt)';

/**
 * Where the Windows helper runs from: copied into the data directory, which
 * no sandboxed command can write, rather than spawned from the package (in a
 * development checkout that sits inside the workspace's write grant).
 */
async function srtWinPath(dataDir: string): Promise<string | undefined> {
  const path = join(dataDir, 'sandbox', 'srt-win.exe');
  if (existsSync(path)) return path;
  const embedded = Bun.embeddedFiles.find((f) => (f as File).name?.startsWith('srt-win-'));
  const source = embedded ? undefined : VENDORED_SRT_WIN_EXE;
  if (!embedded && !(source && existsSync(source))) return undefined;
  mkdirSync(join(dataDir, 'sandbox'), { recursive: true });
  if (embedded) writeFileSync(path, new Uint8Array(await embedded.arrayBuffer()));
  else copyFileSync(source as string, path);
  return path;
}

export interface WindowsSandboxResult {
  ok: boolean;
  message: string;
}

/** `switchback sandbox install`: the sandbox account and network filter (one UAC prompt). */
export async function installSandbox(dataDir: string): Promise<WindowsSandboxResult> {
  if (process.platform !== 'win32') return platformNote();
  const path = await srtWinPath(dataDir);
  if (!path) return { ok: false, message: "this build doesn't include the Windows sandbox helper" };
  const result = await installWindowsSandboxAsync({ srtWin: resolveSrtWin({ path }) });
  if (result.cancelled)
    return { ok: false, message: 'the administrator prompt was dismissed; nothing changed' };
  return { ok: true, message: 'the command sandbox is set up for every user on this machine' };
}

/** Whether commands can be sandboxed without an install step first. */
export async function sandboxInstalled(dataDir: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const path = await srtWinPath(dataDir);
  if (!path) return false;
  const deps = await checkWindowsDependenciesAsync({ srtWin: resolveSrtWin({ path }) });
  return deps.errors.length === 0;
}

/** `switchback sandbox uninstall`. */
export async function uninstallSandbox(dataDir: string): Promise<WindowsSandboxResult> {
  if (process.platform !== 'win32') return platformNote();
  const path = await srtWinPath(dataDir);
  if (!path) return { ok: false, message: "this build doesn't include the Windows sandbox helper" };
  const result = uninstallWindowsSandbox({ srtWin: resolveSrtWin({ path }) });
  if (result.cancelled)
    return { ok: false, message: 'the administrator prompt was dismissed; nothing changed' };
  return { ok: true, message: 'the command sandbox is removed' };
}

function platformNote(): WindowsSandboxResult {
  return {
    ok: true,
    message: `${process.platform === 'darwin' ? 'macOS' : 'Linux'} needs no install step; \`switchback doctor\` says whether the sandbox is on`,
  };
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
