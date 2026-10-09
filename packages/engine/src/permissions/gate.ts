/**
 * Whether a tool call may run (docs/permissions.md), in this order:
 *
 * 1. A category set to `deny` (or an MCP server's `permission: deny`), and
 *    places no tool may go: Switchback's data and credentials, and the
 *    credentials in `bash.sandbox.denyRead` (ADR 0018).
 * 2. Deny rules, and `permissions.outsideWorkspace: deny` for paths outside
 *    the workspace.
 * 3. Plan mode: no edits.
 * 4. `bypassPermissions`: everything else runs, without a prompt.
 * 5. Ask rules, a command that wants to leave the sandbox, and edits to the
 *    agent's own configuration: always ask in the other modes. An edit
 *    outside the workspace asks unless an allow rule names the place.
 * 6. A PreToolUse hook's decision (its deny is applied before the gate, its
 *    ask asks, its allow skips a level's prompt), then allow rules, including
 *    what the user allowed this session.
 * 7. The mode: `acceptEdits` allows edits.
 * 8. The category's level: `allow`, or ask.
 */
import type { PermissionDecision, PermissionMode } from '@switchback/protocol';
import type { HookOutcome } from '../hooks/runner.ts';
import { type EngineHost, type LiveSession, scope } from '../live-session.ts';
import { PendingPrompts } from '../prompts.ts';
import {
  insideWorkspace,
  type PlanAnswer,
  resolveFile,
  type Tool,
  type ToolContext,
  type ToolPreview,
  toWorkspacePath,
} from '../tools/index.ts';
import { folderRule, type Places, pathOf, type Reach, reachOf } from './outside.ts';
import { PermissionPolicy, type SourcedRule, suggestRules, type ToolCall } from './policy.ts';
import { ignoreInGit, saveAllowRules } from './save.ts';

export interface PermissionAnswer {
  decision: PermissionDecision;
  save?: 'project' | 'user';
  /** With a deny: what the user wants instead. */
  feedback?: string;
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
  /** Switchback's own folders and the credentials no tool may read. */
  places(): Places;
}

/** Why the user is asked, and whether "always" may be offered (and as which rules). */
interface AskWhy {
  /** The ask rule that caught the call: it asks every time, so no "always". */
  askRule?: string;
  /** Another reason, shown with the prompt. */
  reason?: string;
  /** What "always" grants instead of the usual suggestion; empty offers none. */
  rules?: string[];
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
    const reach = this.reach(call, ctx);
    if (reach?.kind === 'off-limits')
      return {
        allowed: false,
        error: `${reach.path} is off limits: ${reach.why}. Don't retry it; if it's needed, ask the user to do it.`,
      };
    const away = reach?.kind === 'outside' || reach?.kind === 'switchback' ? reach : undefined;
    if (away && levels.outsideWorkspace === 'deny')
      return {
        allowed: false,
        error: `${away.path} is outside the workspace, and permissions.outsideWorkspace is deny. Work inside the workspace, or ask the user.`,
      };
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
    const forced = this.mustAsk(tool, input, ctx, reach);
    if ('refused' in forced) return { allowed: false, error: forced.refused };
    // Bypass never prompts; only the denials above stop a call.
    if (mode === 'bypassPermissions') return { allowed: true };
    if (forced.ask) return this.ask(s, tool, call, ctx, signal, { reason: forced.ask, rules: [] });
    if (verdict?.behavior === 'ask')
      return this.ask(s, tool, call, ctx, signal, { askRule: verdict.rule.rule });
    if (hook?.behavior === 'ask')
      return this.ask(s, tool, call, ctx, signal, {
        reason: `a hook${hook.reason ? `: ${hook.reason}` : ''}`,
      });
    // Reads outside the workspace follow `permissions.read` like any other.
    // Editing there takes a rule that names the place; `edit: allow`, a bare
    // `edit` rule, a hook, or acceptEdits isn't enough.
    if (away && tool.permission === 'edit') {
      if (verdict?.behavior === 'allow' && verdict.rule.rule.includes('('))
        return { allowed: true };
      return this.ask(s, tool, call, ctx, signal, {
        reason: 'outside the workspace',
        rules: [folderRule(away.path)],
      });
    }
    // A hook's allow skips the prompt a level would show (ask rules asked above).
    if (hook?.behavior === 'allow') return { allowed: true };
    if (verdict?.behavior === 'allow') return { allowed: true };
    if (mode === 'acceptEdits' && tool.permission === 'edit') return { allowed: true };
    if (level === 'allow') return { allowed: true };
    return this.ask(s, tool, call, ctx, signal, {});
  }

  /** Where a file tool's path goes; undefined for other tools. */
  private reach(call: ToolCall, ctx: ToolContext): Reach | undefined {
    const path = pathOf(call) ?? (call.category === 'read' ? '.' : undefined);
    if (path === undefined) return undefined;
    const file = resolveFile(ctx.workspaceRoot, path);
    return reachOf(file, insideWorkspace(ctx.workspaceRoot, file), this.deps.places());
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
    reach: Reach | undefined,
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
    if (tool.permission === 'edit' && reach?.kind === 'switchback')
      return { ask: "Switchback's own configuration" };
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
    why: AskWhy,
  ): Promise<GateResult> {
    const { askRule, reason } = why;
    let preview: ToolPreview | undefined;
    try {
      preview = await tool.preview?.(call.input, ctx);
    } catch (err) {
      // The call would fail anyway; the model hears why and the user isn't asked.
      return { allowed: false, error: (err as Error).message, failed: true };
    }
    const rules = why.rules ?? suggestRules(call);
    const answer = await this.prompt(
      s,
      {
        tool: tool.name,
        summary: tool.summarize(call.input),
        input: call.input,
        ...(preview ? { preview: preview.diff } : {}),
        ...(preview?.proposed ? { proposed: preview.proposed } : {}),
        // An ask rule asks every time; offering "always" would contradict it,
        // as would a grant when the organization sets everyone's permissions.
        ...(rules.length && !askRule && !this.host.org()?.userPermissionsDisabled ? { rules } : {}),
        ...(askRule ? { askRule } : {}),
        ...(reason ? { reason } : {}),
      },
      signal,
    );
    if (answer.decision === 'allow_always' && !askRule && !this.host.org()?.userPermissionsDisabled)
      this.remember(rules, answer.save);
    if (answer.decision === 'deny' && answer.feedback)
      return {
        allowed: false,
        error: `The user declined this and said what to do instead:\n${answer.feedback}`,
      };
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
      reason?: string;
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
