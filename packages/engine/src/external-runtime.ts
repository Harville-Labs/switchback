/**
 * Subagents that run on an external agent runtime (ADR 0009). It's remote
 * spend, so it obeys routing like any remote call; its tools go through the
 * permission policy; its progress is emitted on the child session; its cost is
 * ledgered.
 */
import { z } from 'zod';
import type { AgentDefinition } from './agents.ts';
import { type EngineHost, type LiveSession, scope, type TurnResult } from './live-session.ts';
import { privateToolUse } from './privacy.ts';
import { ClaudeAgentSdkRuntime } from './runtimes/claude-agent-sdk.ts';
import type { AgentRuntime } from './runtimes/runtime.ts';
import type { InvocationBudget } from './subagents.ts';
import type { Tool, ToolContext } from './tools/index.ts';

export interface ExternalRuntimeDeps {
  /** Runtimes supplied by the embedder (tests), overriding config. */
  injected: Map<string, AgentRuntime> | undefined;
  invocationBudget(s: LiveSession): InvocationBudget | undefined;
  checkPermission(
    s: LiveSession,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; error?: string }>;
}

export class ExternalRuntimes {
  constructor(
    private readonly host: EngineHost,
    private readonly deps: ExternalRuntimeDeps,
  ) {}

  async run(
    s: LiveSession,
    agent: AgentDefinition,
    prompt: string,
    parentSignal: AbortSignal,
  ): Promise<TurnResult> {
    const turnId = `turn_${crypto.randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onAbort, { once: true });
    s.controller = controller;
    this.host.emit({ type: 'turn.started', ...scope(s), turnId });
    this.host.append(s, { role: 'user', parts: [{ type: 'text', text: prompt }] });
    let result: TurnResult;
    try {
      result = await this.runChecked(s, agent, prompt, turnId, controller.signal);
    } finally {
      s.controller = undefined;
      parentSignal.removeEventListener('abort', onAbort);
    }
    this.host.emit({ type: 'turn.completed', ...scope(s), turnId, stopReason: result.stopReason });
    return result;
  }

  private async runChecked(
    s: LiveSession,
    agent: AgentDefinition,
    prompt: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    const fail = (message: string): TurnResult => {
      s.lastError = message;
      this.host.emit({ type: 'error', ...scope(s), turnId, message });
      return { stopReason: 'error', text: '' };
    };
    const name = agent.runtime as string;
    const runtime = this.runtime(name);
    const blocked = this.host.remoteBlocked(s);
    const budget = this.deps.invocationBudget(s);
    if (!runtime)
      return fail(
        `agent "${agent.name}" names runtime "${name}", which isn't configured under runtimes`,
      );
    if (blocked) return fail(`${blocked}; external runtimes are remote`);
    if (budget && budget.spentUsd >= budget.limitUsd)
      return fail(`subagent "${budget.agent}" has spent its $${budget.limitUsd.toFixed(2)} budget`);

    const model = { provider: name, model: this.host.config().runtimes[name]?.model ?? name };
    this.host.emit({
      type: 'route.decided',
      ...scope(s),
      turnId,
      tier: 'remote',
      model,
      rule: 'runtime',
      reason: `agent "${agent.name}" runs on ${runtime.label}`,
    });
    const ctx: ToolContext = {
      workspaceRoot: this.host.rootOf(s),
      sessionId: s.header.id,
      signal,
      agentCatalog: [],
    };
    const r = await runtime.run({
      prompt,
      cwd: ctx.workspaceRoot,
      signal,
      ...(budget ? { budgetUsd: Math.max(0, budget.limitUsd - budget.spentUsd) } : {}),
      canUseTool: (tool, input) => this.canUseTool(s, ctx, tool, input, signal),
      onEvent: (ev) => {
        if (ev.type === 'text')
          this.host.emit({ type: 'text.delta', ...scope(s), turnId, text: ev.text });
        else if (ev.type === 'tool.started')
          this.host.emit({
            type: 'tool.started',
            ...scope(s),
            turnId,
            callId: ev.callId,
            name: ev.name,
            input: ev.input,
          });
        else
          this.host.emit({
            type: 'tool.completed',
            ...scope(s),
            turnId,
            callId: ev.callId,
            name: ev.name,
            output: ev.output,
            isError: ev.isError,
          });
      },
    });
    for (const call of r.calls)
      this.host.recordUsage(s, 'remote', call.model, call.usage, {
        rule: 'runtime',
        agent: agent.name,
        costUsd: call.costUsd,
      });
    this.host.append(s, {
      role: 'assistant',
      parts: [{ type: 'text', text: r.text }],
      meta: { model, tier: 'remote', routeReason: `runs on ${runtime.label}` },
    });
    if (r.ok) return { stopReason: 'end_turn', text: r.text };
    return signal.aborted ? { stopReason: 'cancelled', text: r.text } : fail(r.text);
  }

  private async canUseTool(
    s: LiveSession,
    ctx: ToolContext,
    tool: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; message?: string }> {
    // The runtime's model is remote: it may not read private files.
    const i = (input ?? {}) as Record<string, unknown>;
    const matches = this.host.privatePaths();
    const named = matches
      ? (privateToolUse(matches, ctx.workspaceRoot, 'read', { path: i.file_path ?? i.path }, '') ??
        privateToolUse(matches, ctx.workspaceRoot, 'bash', { command: i.command }, ''))
      : undefined;
    if (named)
      return {
        allowed: false,
        message: `${named.replace(/^(read|a command named) /, '')} is private (privacy.localOnlyPaths) and can't be sent to a remote model`,
      };
    const p = await this.deps.checkPermission(s, externalTool(tool), input, ctx, signal);
    return { allowed: p.allowed, ...(p.error ? { message: p.error } : {}) };
  }

  private runtime(name: string): AgentRuntime | undefined {
    const injected = this.deps.injected?.get(name);
    if (injected) return injected;
    const cfg = this.host.config().runtimes[name];
    if (!cfg) return undefined;
    return new ClaudeAgentSdkRuntime({
      name,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.maxTurns ? { maxTurns: cfg.maxTurns } : {}),
      ...(cfg.executable ? { executable: cfg.executable } : {}),
    });
  }
}

/**
 * A stand-in Tool for a call an external runtime wants to make, so the
 * engine's permission policy applies. Unknown tools are treated like `bash`.
 */
function externalTool(name: string): Tool {
  const category: Tool['permission'] = /^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|Task)$/.test(
    name,
  )
    ? 'read'
    : /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)
      ? 'edit'
      : /^(WebFetch|WebSearch)$/.test(name)
        ? 'web'
        : name.startsWith('mcp__')
          ? 'mcp'
          : 'bash';
  return {
    name,
    description: '',
    schema: z.unknown(),
    permission: category,
    permissionKey: category === 'mcp' ? `mcp:${name.split('__')[1] ?? ''}` : category,
    mutating: category !== 'read',
    summarize: (input) => {
      const args = JSON.stringify(input ?? {});
      return `${name} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`;
    },
    run: async () => {
      throw new Error('external tools run in their runtime');
    },
  };
}
