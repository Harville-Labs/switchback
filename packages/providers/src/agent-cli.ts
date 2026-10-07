/**
 * A coding agent CLI the user is signed in to (Claude Code, Codex), used as a
 * model. It doesn't serve chat completions: it works whole turns with its own
 * tools, and the engine hands it those turns (engine/src/runtimes). This
 * provider only says where the CLI is and whether it's there.
 */
import type { ChatEvent, HealthStatus, Provider } from './types.ts';

export type AgentCliKind = 'claude-code' | 'codex';

const CLI: Record<AgentCliKind, { command: string; install: string }> = {
  'claude-code': {
    command: 'claude',
    install: 'install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` to sign in',
  },
  codex: {
    command: 'codex',
    install: 'install Codex (npm i -g @openai/codex) and run `codex login`',
  },
};

export class AgentCliProvider implements Provider {
  readonly tier = 'remote' as const;

  constructor(
    readonly id: string,
    readonly kind: AgentCliKind,
    private readonly executable?: string,
  ) {}

  /** The CLI to run: the configured path, else the one on PATH. */
  binary(): string | undefined {
    return this.executable ?? Bun.which(CLI[this.kind].command) ?? undefined;
  }

  /**
   * Always up: without the CLI on PATH, its SDK runs the CLI it ships with,
   * on the same sign-in. A turn that can't run (not signed in, say) fails
   * with the CLI's own explanation.
   */
  async health(): Promise<HealthStatus> {
    const binary = this.binary();
    return {
      ok: true,
      detail:
        binary ??
        `the SDK's bundled \`${CLI[this.kind].command}\` (to use your own: ${CLI[this.kind].install})`,
    };
  }

  // biome-ignore lint/correctness/useYield: it never streams; the engine runs its turns instead
  async *stream(): AsyncIterable<ChatEvent> {
    throw new Error(
      `${this.kind} runs whole turns through its CLI; it isn't called for completions`,
    );
  }
}
