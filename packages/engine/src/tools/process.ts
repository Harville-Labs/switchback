/**
 * Running shell commands for the bash tools: one place that spawns them (the
 * OS sandbox wraps it), and the background shells a session keeps running
 * across turns (dev servers, watchers).
 */
import { basename } from 'node:path';
import type { ShellInfo } from '@switchback/protocol';
import type { Subprocess } from 'bun';
import {
  BashSandbox,
  type SandboxContext,
  type SandboxSettings,
  type SandboxState,
  sandboxPolicy,
} from './sandbox.ts';
import { currentShell, type Shell } from './shell.ts';
import { ToolError } from './tool.ts';

export interface CommandSettings {
  /** Default timeout for a foreground command. */
  timeoutMs: number;
  /** Added to the environment of every command. */
  env: Record<string, string>;
  /** A POSIX shell to use instead of the detected one, e.g. `/bin/zsh`. */
  shell?: string;
  sandbox: SandboxSettings;
}

/** What the sandbox needs to know about where a command runs. */
export interface SandboxDeps {
  runtime: BashSandbox;
  context(cwd: string): SandboxContext;
  /** Said once when the sandbox can't run (mode `auto`). */
  notice(message: string): void;
}

export interface Spawned {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  /** Set when the command runs sandboxed: the key for `explain`. */
  sandboxId?: string;
}

/** Background output kept per shell; older output is dropped first. */
const MAX_BUFFER = 1_000_000;

export type BackgroundShell = ShellInfo;

interface Entry extends BackgroundShell {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  output: string;
  /** Characters dropped from the front of `output` when it grew past the cap. */
  dropped: number;
  /** Position up to which the model has read, in the full output. */
  read: number;
}

/**
 * Stop a command and everything it started. On Windows killing the shell
 * leaves its children running (and holding its output pipes open), so the
 * whole tree goes; elsewhere the shell's signal reaches its foreground job.
 */
export function terminate(proc: Subprocess): void {
  if (process.platform === 'win32')
    Bun.spawnSync(['taskkill', '/pid', String(proc.pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  else proc.kill();
}

/** How long output is still read after a command exits (a child may hold the pipe). */
const DRAIN_MS = 500;

/**
 * A stream's text, read until it ends or until `exited` resolves and a short
 * drain passes: a background child that inherited the pipe can't keep the
 * call waiting.
 */
export async function readUntilExit(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<unknown>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let stop = false;
  void exited.then(() =>
    setTimeout(() => {
      stop = true;
      void reader.cancel().catch(() => {});
    }, DRAIN_MS),
  );
  try {
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Cancelled after the drain: what was read is the output.
  }
  return text + decoder.decode();
}

export function shellOf(settings: Pick<CommandSettings, 'shell'>): Shell {
  if (!settings.shell) return currentShell();
  const path = settings.shell;
  return { name: basename(path), argv: (c) => [path, '-c', c] };
}

/** A command runner for an engine: sandboxed as `bash.sandbox` says, unless the embedder turned the sandbox off (`false`). */
export function createCommandRunner(o: {
  settings: () => CommandSettings;
  onChange: (shell: BackgroundShell) => void;
  sandbox: BashSandbox | false | undefined;
  workspaceRoot: string;
  /** Switchback's own config and data directories, which commands may never write. */
  switchbackDirs: string[];
  dataDir: string;
  rules: () => SandboxContext['rules'];
  notice: (message: string) => void;
}): CommandRunner {
  return new CommandRunner(
    o.settings,
    o.onChange,
    o.sandbox === false
      ? undefined
      : {
          runtime: o.sandbox ?? new BashSandbox(o.dataDir),
          context: (cwd) => ({
            workspaceRoot: o.workspaceRoot,
            sessionRoot: cwd,
            switchbackDirs: o.switchbackDirs,
            rules: o.rules(),
          }),
          notice: o.notice,
        },
  );
}

export class CommandRunner {
  private shells = new Map<string, Entry>();

  private noticed = false;

  constructor(
    private readonly settings: () => CommandSettings,
    /** A background shell started or stopped. */
    private readonly onChange: (shell: BackgroundShell) => void = () => {},
    /** Without it, commands run unsandboxed (tests, embedding). */
    private readonly sandbox?: SandboxDeps,
  ) {}

  get timeoutMs(): number {
    return this.settings().timeoutMs;
  }

  /**
   * Start a command: in the sandbox when it's available and on, unless the
   * user approved this one call running outside it (`unsandboxed`).
   */
  async spawn(command: string, cwd: string, unsandboxed = false): Promise<Spawned> {
    const s = this.settings();
    const env = { ...s.env, SWITCHBACK: '1' };
    const io = { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' } as const;
    const shell = shellOf(s);
    const state: SandboxState =
      this.sandbox && !unsandboxed
        ? await this.sandbox.runtime.state(s.sandbox.mode)
        : { active: false, reason: unsandboxed ? 'approved' : 'no sandbox' };
    if (state.active && this.sandbox) {
      const sandboxId = `cmd_${crypto.randomUUID().slice(0, 12)}`;
      const policy = sandboxPolicy(s.sandbox, this.sandbox.context(cwd));
      const shellPath = shell.argv('')[0] as string;
      const wrapped = await this.sandbox.runtime.wrap(command, shellPath, cwd, policy, sandboxId);
      const proc = Bun.spawn(wrapped.argv, { ...io, env: { ...wrapped.env, ...env } });
      return { proc, sandboxId };
    }
    const reason = state.active ? '' : state.reason;
    if (this.sandbox && !unsandboxed && s.sandbox.mode === 'on')
      throw new ToolError(
        `bash.sandbox.mode is on, but ${reason}; nothing ran. Install what's missing, or set bash.sandbox.mode to auto.`,
      );
    if (this.sandbox && !unsandboxed && s.sandbox.mode === 'auto' && !this.noticed) {
      this.noticed = true;
      this.sandbox.notice(`bash commands run without the OS sandbox: ${reason}`);
    }
    return { proc: Bun.spawn(shell.argv(command), { ...io, env: { ...process.env, ...env } }) };
  }

  /** Whether commands will run sandboxed, and if not, why. */
  sandboxState(): Promise<SandboxState> {
    return this.sandbox
      ? this.sandbox.runtime.state(this.settings().sandbox.mode)
      : Promise.resolve({ active: false, reason: 'this engine runs commands unsandboxed' });
  }

  /** stderr with what the sandbox blocked spelled out. */
  explain(spawned: Spawned, stderr: string): string {
    return spawned.sandboxId && this.sandbox
      ? this.sandbox.runtime.explain(spawned.sandboxId, stderr)
      : stderr;
  }

  /** Start a command that keeps running after the call returns. */
  async start(
    sessionId: string,
    command: string,
    cwd: string,
    unsandboxed = false,
  ): Promise<BackgroundShell> {
    const id = `sh_${crypto.randomUUID().slice(0, 6)}`;
    const { proc } = await this.spawn(command, cwd, unsandboxed);
    const entry: Entry = {
      id,
      sessionId,
      command,
      startedAt: Date.now(),
      status: 'running',
      proc,
      output: '',
      dropped: 0,
      read: 0,
    };
    this.shells.set(id, entry);
    void this.collect(entry, proc.stdout);
    void this.collect(entry, proc.stderr);
    void proc.exited.then((code) => {
      if (entry.status === 'running') {
        entry.status = 'exited';
        entry.exitCode = code;
      }
      this.onChange(view(entry));
    });
    this.onChange(view(entry));
    return view(entry);
  }

  /** Output since the last read, and whether the shell is still running. */
  read(id: string, sessionId: string): { shell: BackgroundShell; output: string; skipped: number } {
    const e = this.entry(id, sessionId);
    const from = Math.max(e.read, e.dropped);
    const output = e.output.slice(from - e.dropped);
    const skipped = from - e.read;
    e.read = e.dropped + e.output.length;
    return { shell: view(e), output, skipped };
  }

  kill(id: string, sessionId?: string): BackgroundShell {
    const e = this.entry(id, sessionId);
    if (e.status === 'running') {
      e.status = 'killed';
      terminate(e.proc);
    }
    return view(e);
  }

  list(sessionId?: string): BackgroundShell[] {
    return [...this.shells.values()]
      .filter((e) => !sessionId || e.sessionId === sessionId)
      .map(view);
  }

  /** Background shells end with the engine, and so does the sandbox's proxy. */
  async close(): Promise<void> {
    for (const e of this.shells.values()) if (e.status === 'running') this.kill(e.id);
    await this.sandbox?.runtime.close();
  }

  private entry(id: string, sessionId: string | undefined): Entry {
    const e = this.shells.get(id);
    // A session sees only its own shells.
    if (!e || (sessionId && e.sessionId !== sessionId))
      throw new ToolError(
        `no background shell ${id}; running: ${
          this.list(sessionId)
            .map((s) => s.id)
            .join(', ') || 'none'
        }`,
      );
    return e;
  }

  private async collect(e: Entry, stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      e.output += decoder.decode(chunk, { stream: true });
      if (e.output.length > MAX_BUFFER) {
        const cut = e.output.length - MAX_BUFFER;
        e.output = e.output.slice(cut);
        e.dropped += cut;
      }
    }
  }
}

function view(e: Entry): BackgroundShell {
  return {
    id: e.id,
    sessionId: e.sessionId,
    command: e.command,
    startedAt: e.startedAt,
    status: e.status,
    ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
  };
}
