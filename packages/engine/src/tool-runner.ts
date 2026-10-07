/**
 * Running a model's tool calls: validation, the permission gate, privacy
 * marks, and parallel execution of calls that don't mutate anything.
 */
import type { ImagePart, ToolResultPart } from '@switchback/protocol';
import type { HookOutcome, HookRunner } from './hooks/runner.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { PermissionGate } from './permissions/gate.ts';
import { privateToolUse } from './privacy.ts';
import type { Skill } from './skills.ts';
import type { CommandRunner, SubagentResult, Tool, ToolContext } from './tools/index.ts';

export type Interaction = 'prompt' | 'approve' | 'deny';

export interface ToolRunnerDeps {
  commands: CommandRunner;
  hooks: HookRunner;
  /** What every hook hears about the session (its ID, the permission mode). */
  hookPayload(s: LiveSession): Record<string, unknown>;
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
  skills(): Map<string, Skill>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export class ToolRunner {
  constructor(
    private readonly host: EngineHost,
    private readonly gate: PermissionGate,
    private readonly deps: ToolRunnerDeps,
  ) {}

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
    const root = this.host.rootOf(s);
    const policy = this.gate.policy();
    const ctx: ToolContext = {
      workspaceRoot: root,
      sessionId: s.header.id,
      signal,
      agentCatalog: catalog,
      runSubagent: (agent, prompt, description, options) =>
        this.deps.runSubagent(s, agent, prompt, description, signal, options),
      hidden: (path) => policy.hides(path, root),
      web: this.host.config().web,
      ...(s.private ? { privateReason: s.private } : {}),
      commands: this.deps.commands,
      skills: () => this.deps.skills(),
      ...(s.depth === 0
        ? { approvePlan: (plan: string) => this.gate.approvePlan(s, plan, signal) }
        : {}),
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

  private hook(
    s: LiveSession,
    event: 'PreToolUse' | 'PostToolUse',
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<HookOutcome> {
    if (!this.deps.hooks.has(event)) return Promise.resolve({ context: [] });
    return this.deps.hooks.run(
      event,
      { ...this.deps.hookPayload(s), tool_name: toolName, ...payload },
      toolName,
    );
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
    let images: ImagePart[] = [];
    let diff: string | undefined;
    const pre = await this.hook(s, 'PreToolUse', call.name, { tool_input: parsed.data });
    const hookDenied =
      pre.block ??
      (pre.decision?.behavior === 'deny' ? (pre.decision.reason ?? 'no reason given') : undefined);
    const permission = hookDenied
      ? { allowed: false, error: `Blocked by a PreToolUse hook: ${hookDenied}` }
      : await this.gate.check(s, tool, parsed.data, callCtx, signal, pre.decision);
    const denied = !permission.allowed && !permission.failed;
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
        const result = await tool.run(parsed.data, callCtx);
        if (typeof result === 'string') output = result;
        else ({ text: output, images, diff } = result);
      } catch (err) {
        output = (err as Error).message;
        isError = true;
      }
      const post = await this.hook(s, 'PostToolUse', call.name, {
        tool_input: parsed.data,
        tool_response: { output, isError },
      });
      // The call already ran; hooks can only tell the model something about it.
      const notes = [...(post.block ? [`PostToolUse hook: ${post.block}`] : []), ...post.context];
      if (notes.length) output = `${output}\n\n${notes.join('\n')}`;
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
      ...(denied ? { denied } : {}),
      ...(priv ? { private: priv } : {}),
      ...(diff && !isError ? { diff } : {}),
    });
    return {
      type: 'tool_result',
      callId: call.id,
      content: output,
      ...(isError ? { isError } : {}),
      ...(priv ? { private: priv } : {}),
      ...(images.length ? { images } : {}),
    };
  }
}
