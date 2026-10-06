/**
 * Running shell commands for the bash tools: one place that spawns them (the
 * OS sandbox wraps it), and the background shells a session keeps running
 * across turns (dev servers, watchers).
 */
import { basename } from 'node:path';
import type { ShellInfo } from '@switchback/protocol';
import type { Subprocess } from 'bun';
import { currentShell, type Shell } from './shell.ts';
import { ToolError } from './tool.ts';

export interface CommandSettings {
  /** Default timeout for a foreground command. */
  timeoutMs: number;
  /** Added to the environment of every command. */
  env: Record<string, string>;
  /** A POSIX shell to use instead of the detected one, e.g. `/bin/zsh`. */
  shell?: string;
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

export function shellOf(settings: Pick<CommandSettings, 'shell'>): Shell {
  if (!settings.shell) return currentShell();
  const path = settings.shell;
  return { name: basename(path), argv: (c) => [path, '-c', c] };
}

export class CommandRunner {
  private shells = new Map<string, Entry>();

  constructor(
    private readonly settings: () => CommandSettings,
    /** A background shell started or stopped. */
    private readonly onChange: (shell: BackgroundShell) => void = () => {},
  ) {}

  get timeoutMs(): number {
    return this.settings().timeoutMs;
  }

  spawn(command: string, cwd: string): Subprocess<'ignore', 'pipe', 'pipe'> {
    const s = this.settings();
    return Bun.spawn(shellOf(s).argv(command), {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, ...s.env, SWITCHBACK: '1' },
    });
  }

  /** Start a command that keeps running after the call returns. */
  start(sessionId: string, command: string, cwd: string): BackgroundShell {
    const id = `sh_${crypto.randomUUID().slice(0, 6)}`;
    const proc = this.spawn(command, cwd);
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
      e.proc.kill();
    }
    return view(e);
  }

  list(sessionId?: string): BackgroundShell[] {
    return [...this.shells.values()]
      .filter((e) => !sessionId || e.sessionId === sessionId)
      .map(view);
  }

  /** Background shells end with the engine. */
  killAll(): void {
    for (const e of this.shells.values()) if (e.status === 'running') this.kill(e.id);
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
