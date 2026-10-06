/**
 * Running a model's tool calls: validation, the permission policy, privacy
 * marks, and parallel execution of calls that don't mutate anything.
 */
import type { PermissionDecision, ToolResultPart } from '@switchback/protocol';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import { privateToolUse } from './privacy.ts';
import { PendingPrompts } from './prompts.ts';
import type { SubagentResult, Tool, ToolContext, ToolPreview } from './tools/index.ts';

export type Interaction = 'prompt' | 'approve' | 'deny';

export interface ToolRunnerDeps {
  /** How `ask` is resolved when no client answers (headless runs approve or deny). */
  interaction(): Interaction;
  runSubagent(
    parent: LiveSession,
    agent: string,
    prompt: string,
    description: string,
    signal: AbortSignal,
    options?: { background?: boolean; isolation?: 'worktree' },
  ): Promise<SubagentResult>;
  /** An edit or write is about to run; review remembers the file's content first. */
  noteEdit(s: LiveSession, path: string, writer: string): void;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export class ToolRunner {
  readonly permissions = new PendingPrompts<PermissionDecision>('permission');
  /** Categories (or MCP servers) the user allowed for the engine's lifetime. */
  private alwaysAllowed = new Set<string>();

  constructor(
    private readonly host: EngineHost,
    private readonly deps: ToolRunnerDeps,
  ) {}

  /** Grants were made under the old policy. */
  revokeGrants(): void {
    this.alwaysAllowed.clear();
  }

  async run(
    s: LiveSession,
    tools: Tool[],
    catalog: ToolContext['agentCatalog'],
    calls: ToolCall[],
    turnId: string,
    signal: AbortSignal,
    /** The alias of the model that made these calls, for review. */
    writer: string,
  ): Promise<ToolResultPart[]> {
    const ctx: ToolContext = {
      workspaceRoot: this.host.rootOf(s),
      sessionId: s.header.id,
      signal,
      agentCatalog: catalog,
      runSubagent: (agent, prompt, description, options) =>
        this.deps.runSubagent(s, agent, prompt, description, signal, options),
    };
    const runOne = (call: ToolCall) => this.runOne(s, tools, ctx, call, turnId, signal, writer);
    const allParallelSafe = calls.every(
      (c) => tools.find((t) => t.name === c.name)?.mutating === false,
    );
    if (allParallelSafe) return Promise.all(calls.map(runOne));
    const results: ToolResultPart[] = [];
    for (const call of calls) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', callId: call.id, content: 'cancelled', isError: true });
        continue;
      }
      results.push(await runOne(call));
    }
    return results;
  }

  private async runOne(
    s: LiveSession,
    tools: Tool[],
    ctx: ToolContext,
    call: ToolCall,
    turnId: string,
    signal: AbortSignal,
    writer: string,
  ): Promise<ToolResultPart> {
    const tool = tools.find((t) => t.name === call.name);
    // A subagent that saw private content passes that on with its report.
    let fromSubagent: string | undefined;
    const callCtx: ToolContext = {
      ...ctx,
      runSubagent: async (agent, prompt, description, options) => {
        const r = await this.deps.runSubagent(s, agent, prompt, description, signal, options);
        if (r.private) fromSubagent ??= r.private;
        return r;
      },
    };
    const parsed = tool?.schema.safeParse(call.input);
    if (!tool || !parsed?.success) {
      s.signals.recordMalformedToolCall();
      const message = !tool
        ? `unknown tool "${call.name}"; available: ${tools.map((t) => t.name).join(', ')}`
        : `invalid arguments: ${parsed?.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      this.host.emit({
        type: 'tool.completed',
        ...scope(s),
        turnId,
        callId: call.id,
        name: call.name,
        output: message,
        isError: true,
      });
      return { type: 'tool_result', callId: call.id, content: message, isError: true };
    }
    s.signals.recordToolCall(call.name, parsed.data);
    this.host.emit({
      type: 'tool.started',
      ...scope(s),
      turnId,
      callId: call.id,
      name: call.name,
      input: parsed.data,
    });

    let output: string;
    let isError = false;
    let ran = false;
    const permission = await this.check(s, tool, parsed.data, callCtx, signal);
    if (!permission.allowed) {
      output =
        permission.error ??
        'The user denied this action. Do not retry it; ask the user how to proceed.';
      isError = true;
    } else {
      ran = true;
      if (tool.name === 'edit' || tool.name === 'write')
        this.deps.noteEdit(s, (parsed.data as { path: string }).path, writer);
      try {
        output = await tool.run(parsed.data, callCtx);
      } catch (err) {
        output = (err as Error).message;
        isError = true;
      }
    }
    s.signals.recordToolResult(!isError);
    // Even a failed call may have printed private content (a bash error, say).
    const matches = this.host.privatePaths();
    const priv =
      fromSubagent ??
      (ran && matches
        ? privateToolUse(matches, ctx.workspaceRoot, call.name, parsed.data, output)
        : undefined);
    this.host.emit({
      type: 'tool.completed',
      ...scope(s),
      turnId,
      callId: call.id,
      name: call.name,
      output,
      isError,
      ...(priv ? { private: priv } : {}),
    });
    return {
      type: 'tool_result',
      callId: call.id,
      content: output,
      ...(isError ? { isError } : {}),
      ...(priv ? { private: priv } : {}),
    };
  }

  /**
   * Decide whether a tool call may run. `allowed: false` with an `error` means
   * the call would fail anyway (found while building the preview), so the
   * user is never asked about it.
   */
  async check(
    s: LiveSession,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; error?: string }> {
    if (tool.permission === 'none') return { allowed: true };
    const category = this.host.config().permissions[tool.permission];
    // deny first: an org can enforce it, and neither a per-server setting nor a
    // session grant may override that.
    if (category === 'deny') return { allowed: false };
    const level = tool.permissionLevel ?? category;
    if (level === 'deny') return { allowed: false };
    const key = tool.permissionKey ?? tool.permission;
    if (level === 'allow' || this.alwaysAllowed.has(key)) return { allowed: true };
    const mode = this.deps.interaction();
    if (mode !== 'prompt') return { allowed: mode === 'approve' };

    let preview: ToolPreview | undefined;
    try {
      preview = await tool.preview?.(input, ctx);
    } catch (err) {
      return { allowed: false, error: (err as Error).message };
    }

    const requestId = `perm_${crypto.randomUUID().slice(0, 8)}`;
    const decision = await this.permissions.ask(requestId, signal, 'deny', () =>
      this.host.emit({
        type: 'permission.requested',
        ...scope(s),
        requestId,
        tool: tool.name,
        summary: tool.summarize(input),
        input,
        ...(preview ? { preview: preview.diff } : {}),
        ...(preview?.proposed ? { proposed: preview.proposed } : {}),
      }),
    );
    // Every client clears the prompt, whichever one answered (or none, on cancel).
    this.host.emit({ type: 'permission.resolved', ...scope(s), requestId, decision });
    if (decision === 'allow_always') this.alwaysAllowed.add(key);
    return { allowed: decision !== 'deny' };
  }
}
