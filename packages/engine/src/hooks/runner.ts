/**
 * Running hooks: each matching command gets the event as JSON on stdin.
 *
 * - exit 0: carry on; plain stdout is context for the model on
 *   UserPromptSubmit and SessionStart, and JSON stdout can decide (below)
 * - exit 2: block; stderr says why (the model hears it, or for a blocked
 *   prompt, the user)
 * - any other exit: a warning for the user; nothing is blocked
 *
 * JSON output: `decision: "block" | "approve"` with
 * `reason`; `hookSpecificOutput.permissionDecision: "allow" | "deny" |
 * "ask"` with `permissionDecisionReason` (PreToolUse);
 * `hookSpecificOutput.additionalContext`; `continue: false` with
 * `stopReason`; `systemMessage` (shown to the user).
 */
import type { HookEvent, HookMatcher, HooksConfig } from './schema.ts';

export interface HookOutcome {
  /** Set when a hook blocked: why. */
  block?: string;
  /** PreToolUse: what hooks decided about the call; deny beats ask beats allow. */
  decision?: { behavior: 'allow' | 'deny' | 'ask'; reason?: string };
  /** Text for the model (UserPromptSubmit, SessionStart, PostToolUse). */
  context: string[];
}

export interface HookRunnerDeps {
  hooks(): HooksConfig;
  workspaceRoot: string;
  /** The shell argv for a command. */
  argv(command: string): string[];
  notify(level: 'info' | 'warn', message: string): void;
}

const DEFAULT_TIMEOUT_S = 60;

const TOOL_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse']);

export class HookRunner {
  constructor(private readonly deps: HookRunnerDeps) {}

  /** Whether any hook is configured for the event (calls stay cheap without hooks). */
  has(event: HookEvent): boolean {
    return !!this.deps.hooks()[event]?.length;
  }

  /**
   * Run the event's matching hooks in parallel. `subject` is what matchers
   * test: the tool name for tool events, the source for SessionStart.
   */
  async run(
    event: HookEvent,
    payload: Record<string, unknown>,
    subject?: string,
  ): Promise<HookOutcome> {
    const commands = (this.deps.hooks()[event] ?? [])
      .filter((m) => matches(m, event, subject))
      .flatMap((m) => m.hooks);
    const outcome: HookOutcome = { context: [] };
    if (!commands.length) return outcome;
    const input = JSON.stringify({
      ...payload,
      hook_event_name: event,
      cwd: this.deps.workspaceRoot,
    });
    const results = await Promise.all(commands.map((c) => this.exec(c, input)));
    for (const r of results) merge(outcome, r);
    return outcome;
  }

  private async exec(
    hook: HookMatcher['hooks'][number],
    input: string,
  ): Promise<Partial<HookOutcome>> {
    const proc = Bun.spawn(this.deps.argv(hook.command), {
      cwd: this.deps.workspaceRoot,
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SWITCHBACK_PROJECT_DIR: this.deps.workspaceRoot,
      },
    });
    const seconds = hook.timeout ?? DEFAULT_TIMEOUT_S;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, seconds * 1000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    const name = hook.command.length > 60 ? `${hook.command.slice(0, 60)}…` : hook.command;
    if (timedOut) {
      this.deps.notify('warn', `hook "${name}" timed out after ${seconds}s`);
      return {};
    }
    if (code === 2) return { block: stderr.trim() || `blocked by the hook "${name}"` };
    if (code !== 0) {
      this.deps.notify(
        'warn',
        `hook "${name}" failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ''}`,
      );
      return {};
    }
    return this.parse(stdout.trim());
  }

  private parse(stdout: string): Partial<HookOutcome> {
    if (!stdout.startsWith('{')) return stdout ? { context: [stdout] } : {};
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      return { context: [stdout] };
    }
    const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
    const out: Partial<HookOutcome> = {};
    if (typeof json.systemMessage === 'string') this.deps.notify('info', json.systemMessage);
    const reason = str(json.reason) ?? str(specific.permissionDecisionReason);
    if (json.continue === false) out.block = str(json.stopReason) ?? 'stopped by a hook';
    else if (json.decision === 'block') out.block = reason ?? 'blocked by a hook';
    const permission =
      specific.permissionDecision ?? (json.decision === 'approve' ? 'allow' : undefined);
    if (permission === 'allow' || permission === 'deny' || permission === 'ask')
      out.decision = { behavior: permission, ...(reason ? { reason } : {}) };
    if (typeof specific.additionalContext === 'string') out.context = [specific.additionalContext];
    return out;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function matches(m: HookMatcher, event: HookEvent, subject: string | undefined): boolean {
  const pattern = m.matcher?.trim();
  if (!pattern || pattern === '*') return true;
  if (!TOOL_EVENTS.has(event) && event !== 'SessionStart') return true;
  if (subject === undefined) return false;
  // Tool names are case-insensitive, as in agent files and permission rules.
  try {
    return new RegExp(`^(?:${pattern})$`, 'i').test(subject);
  } catch {
    return false;
  }
}

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

function merge(into: HookOutcome, r: Partial<HookOutcome>): void {
  if (r.block) into.block = into.block ? `${into.block}\n${r.block}` : r.block;
  if (r.decision && (!into.decision || RANK[r.decision.behavior] > RANK[into.decision.behavior]))
    into.decision = r.decision;
  if (r.context) into.context.push(...r.context);
}
