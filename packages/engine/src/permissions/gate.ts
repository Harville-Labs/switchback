/**
 * Whether a tool call may run (docs/permissions.md), in this order:
 *
 * 1. A category set to `deny` (or an MCP server's `permission: deny`).
 * 2. Deny rules.
 * 3. Plan mode: no edits.
 * 4. Ask rules, a command that wants to leave the sandbox, and edits to the
 *    agent's own configuration: always ask, whatever the mode.
 * 5. A PreToolUse hook's decision (its deny is applied before the gate, its
 *    ask asks, its allow skips a level's prompt), then allow rules, including
 *    what the user allowed this session.
 * 6. The mode: `bypassPermissions` allows the rest; `acceptEdits` allows edits.
 * 7. The category's level: `allow`, or ask.
 */
import type { PermissionDecision, PermissionMode } from '@switchback/protocol';
import type { HookOutcome } from '../hooks/runner.ts';
import { type EngineHost, type LiveSession, scope } from '../live-session.ts';
import { PendingPrompts } from '../prompts.ts';
import {
  type PlanAnswer,
  type Tool,
  type ToolContext,
  type ToolPreview,
  toWorkspacePath,
} from '../tools/index.ts';
import { PermissionPolicy, type SourcedRule, suggestRules, type ToolCall } from './policy.ts';
import { ignoreInGit, saveAllowRules } from './save.ts';

export interface PermissionAnswer {
  decision: PermissionDecision;
  save?: 'project' | 'user';
}

export interface GateDeps {
  /** How `ask` resolves when no client answers (headless runs approve or deny). */
  interaction(): 'prompt' | 'approve' | 'deny';
  /** The configured rules, with their sources. */
  rules(): SourcedRule[];
  mode(s: LiveSession): PermissionMode;
  setMode(s: LiveSession, mode: PermissionMode): void;
  /** Where "always, for this project" and "always, everywhere" save rules. */
  saveTo: { project: string; user: string };
}

const SESSION = 'this session';

/**
 * Whether a call may run. `error` is what the model hears when it may not;
 * `failed` marks a call that would have failed anyway (found while building
 * the prompt's preview) rather than one the policy or the user refused.
 */
export interface GateResult {
  allowed: boolean;
  error?: string;
  failed?: boolean;
}

/** Switchback's configuration in the workspace: editing it always asks (it could grant more). */
const PROTECTED_CONFIG = ['.switchback'];

export class PermissionGate {
  readonly prompts = new PendingPrompts<PermissionAnswer>('permission');
  /** Rules the user allowed for the engine's lifetime ("always"). */
  private grants: string[] = [];
  private cached: { key: unknown; grants: number; policy: PermissionPolicy } | undefined;

  constructor(
    private readonly host: EngineHost,
    private readonly deps: GateDeps,
  ) {}

  /** Grants were made under the old configuration. */
  revokeGrants(): void {
    this.grants = [];
  }

  /** Every rule in effect, session grants last. */
  policy(): PermissionPolicy {
    const rules = this.deps.rules();
    if (this.cached?.key !== rules || this.cached.grants !== this.grants.length) {
      const granted = this.grants.map((rule) => ({
        rule,
        behavior: 'allow' as const,
        source: SESSION,
      }));
      this.cached = {
        key: rules,
        grants: this.grants.length,
        policy: new PermissionPolicy([...rules, ...granted]),
      };
    }
    return this.cached.policy;
  }

  async check(
    s: LiveSession,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
    /** What PreToolUse hooks decided (deny is handled before the gate). */
    hook?: HookOutcome['decision'],
  ): Promise<GateResult> {
    if (tool.permission === 'none') return { allowed: true };
    const levels = this.host.config().permissions;
    const level = tool.permissionLevel ?? levels[tool.permission];
    // An org can enforce a category's deny; no rule, mode, or grant overrides it.
    if (levels[tool.permission] === 'deny' || level === 'deny')
      return {
        allowed: false,
        error: `${tool.name} is turned off (permissions.${tool.permission} is deny).`,
      };
    const call: ToolCall = { name: tool.name, category: tool.permission, input };
    const verdict = this.policy().evaluate(call, ctx.workspaceRoot);
    if (verdict?.behavior === 'deny')
      return {
        allowed: false,
        error: `Denied by the permission rule ${verdict.rule.rule} (${verdict.rule.source}). Don't retry it; if it's needed, ask the user.`,
      };
    const mode = this.deps.mode(s);
    if (mode === 'plan' && tool.permission === 'edit')
      return {
        allowed: false,
        error:
          "Plan mode is on, so files can't be changed yet. Finish the plan and present it with exit_plan_mode.",
      };
    const forced = this.mustAsk(tool, input, ctx);
    if ('refused' in forced) return { allowed: false, error: forced.refused };
    if (forced.ask) return this.ask(s, tool, call, ctx, signal, forced.ask);
    if (hook?.behavior === 'ask')
      return this.ask(s, tool, call, ctx, signal, `a hook${hook.reason ? `: ${hook.reason}` : ''}`);
    // A hook's allow skips the prompt a level would show, never an ask rule's.
    if (hook?.behavior === 'allow' && verdict?.behavior !== 'ask') return { allowed: true };
    if (verdict?.behavior === 'allow') return { allowed: true };
    if (verdict?.behavior !== 'ask') {
      if (mode === 'bypassPermissions') return { allowed: true };
      if (mode === 'acceptEdits' && tool.permission === 'edit') return { allowed: true };
      if (level === 'allow') return { allowed: true };
    }
    return this.ask(s, tool, call, ctx, signal, verdict?.rule.rule);
  }

  /**
   * Calls that ask whatever the rules and mode say: a command that wants to
   * run outside the OS sandbox, and edits to the agent's own configuration
   * (which could otherwise grant it more).
   */
  private mustAsk(
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
  ): { ask?: string } | { refused: string } {
    const i = (input ?? {}) as { unsandboxed?: unknown; path?: unknown };
    if (tool.permission === 'bash' && i.unsandboxed === true) {
      if (!this.host.config().bash.sandbox.allowUnsandboxed)
        return {
          refused:
            'Running outside the sandbox is turned off (bash.sandbox.allowUnsandboxed). Find a way that works inside it, or ask the user.',
        };
      return { ask: 'running outside the OS sandbox' };
    }
    if (tool.permission === 'edit' && typeof i.path === 'string') {
      const rel = toWorkspacePath(ctx.workspaceRoot, i.path);
      if (rel !== undefined && PROTECTED_CONFIG.some((p) => rel === p || rel.startsWith(`${p}/`)))
        return { ask: "Switchback's own configuration" };
    }
    return {};
  }

  /** Ask the user to approve a plan; approving leaves plan mode. */
  async approvePlan(s: LiveSession, plan: string, signal: AbortSignal): Promise<PlanAnswer> {
    if (this.deps.mode(s) !== 'plan') return 'not-planning';
    const decision = await this.prompt(
      s,
      { tool: 'exit_plan_mode', summary: 'Approve this plan?', input: { plan }, plan },
      signal,
    );
    if (decision.decision === 'deny') return 'rejected';
    const next = decision.decision === 'allow_always' ? 'acceptEdits' : 'default';
    this.deps.setMode(s, next);
    return next === 'acceptEdits' ? 'approved-accept-edits' : 'approved';
  }

  private async ask(
    s: LiveSession,
    tool: Tool,
    call: ToolCall,
    ctx: ToolContext,
    signal: AbortSignal,
    askRule: string | undefined,
  ): Promise<GateResult> {
    let preview: ToolPreview | undefined;
    try {
      preview = await tool.preview?.(call.input, ctx);
    } catch (err) {
      // The call would fail anyway; the model hears why and the user isn't asked.
      return { allowed: false, error: (err as Error).message, failed: true };
    }
    const rules = suggestRules(call);
    const answer = await this.prompt(
      s,
      {
        tool: tool.name,
        summary: tool.summarize(call.input),
        input: call.input,
        ...(preview ? { preview: preview.diff } : {}),
        ...(preview?.proposed ? { proposed: preview.proposed } : {}),
        // An ask rule asks every time; offering "always" would contradict it.
        ...(rules.length && !askRule ? { rules } : {}),
        ...(askRule ? { askRule } : {}),
      },
      signal,
    );
    if (answer.decision === 'allow_always' && !askRule) this.remember(rules, answer.save);
    return { allowed: answer.decision !== 'deny' };
  }

  private async prompt(
    s: LiveSession,
    request: {
      tool: string;
      summary: string;
      input: unknown;
      preview?: string;
      proposed?: { path: string; content: string };
      rules?: string[];
      plan?: string;
      askRule?: string;
    },
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    const mode = this.deps.interaction();
    if (mode !== 'prompt') return { decision: mode === 'approve' ? 'allow_once' : 'deny' };
    const requestId = `perm_${crypto.randomUUID().slice(0, 8)}`;
    const answer = await this.prompts.ask(requestId, signal, { decision: 'deny' }, () =>
      this.host.emit({ type: 'permission.requested', ...scope(s), requestId, ...request }),
    );
    // Every client clears the prompt, whichever one answered (or none, on cancel).
    this.host.emit({
      type: 'permission.resolved',
      ...scope(s),
      requestId,
      decision: answer.decision,
    });
    return answer;
  }

  private remember(rules: string[], save: PermissionAnswer['save']): void {
    this.grants.push(...rules.filter((r) => !this.grants.includes(r)));
    if (!save) return;
    const file = this.deps.saveTo[save];
    try {
      saveAllowRules(file, rules);
      if (save === 'project') ignoreInGit(file);
      this.host.notify('info', `saved ${rules.join(', ')} to ${file}`);
    } catch (err) {
      this.host.notify('warn', `couldn't save the rule to ${file}: ${(err as Error).message}`);
    }
  }
}
