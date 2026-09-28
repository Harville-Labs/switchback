/**
 * External agent runtimes (ADR 0009): a complete agent that runs one task and
 * reports back, used as a subagent.
 */
import type { ModelRef, Usage } from '@harness/protocol';

export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool.started'; callId: string; name: string; input: unknown }
  | { type: 'tool.completed'; callId: string; name: string; output: string; isError: boolean };

export interface RuntimeTask {
  prompt: string;
  /** Working directory (the workspace, or the subagent's worktree). */
  cwd: string;
  signal: AbortSignal;
  /** Remote spend allowed for this run, when the agent has a budget. */
  budgetUsd?: number;
  /** Asked before every tool call; the engine applies its permission policy. */
  canUseTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ allowed: boolean; message?: string }>;
  onEvent(event: RuntimeEvent): void;
}

export interface RuntimeResult {
  ok: boolean;
  text: string;
  /** Usage per model, with the cost the runtime reports. */
  calls: { model: ModelRef; usage: Usage; costUsd: number }[];
}

export interface AgentRuntime {
  /** Shown in routing reasons, e.g. "the Claude Agent SDK". */
  readonly label: string;
  run(task: RuntimeTask): Promise<RuntimeResult>;
}
