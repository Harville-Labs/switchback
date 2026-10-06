/**
 * Subagents: child sessions run for the task tool, in the foreground or in the
 * background, optionally in their own git worktree, within per-invocation
 * budgets.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { RoutePreference } from '@switchback/protocol';
import type { AgentDefinition } from './agents.ts';
import { type EngineHost, type LiveSession, scope, type TurnResult } from './live-session.ts';
import { switchbackPaths } from './paths.ts';
import { Semaphore } from './semaphore.ts';
import { type SubagentResult, ToolError, truncate } from './tools/index.ts';
import { createWorktree, finishWorktree, type Worktree } from './worktree.ts';

export interface SubagentDeps {
  agent(name: string): AgentDefinition | undefined;
  createSession(params: {
    agent: string;
    title: string;
    parentId: string;
    worktree?: Worktree;
  }): LiveSession;
  runTurn(
    s: LiveSession,
    text: string,
    route: RoutePreference,
    signal: AbortSignal | undefined,
    options: { waitForBackground?: boolean; private?: string },
  ): Promise<TurnResult>;
  runExternal(
    s: LiveSession,
    agent: AgentDefinition,
    prompt: string,
    signal: AbortSignal,
  ): Promise<TurnResult>;
  /** Remote spend of one session, from the ledger. */
  sessionCost(sessionId: string): number;
  /** Live sessions whose parent is `sessionId`. */
  children(sessionId: string): LiveSession[];
  workspaceRoot: string;
  dataDir: string | undefined;
}

export type InvocationBudget = { agent: string; limitUsd: number; spentUsd: number };

export class Subagents {
  private slots = new Map<number, Semaphore>();

  constructor(
    private readonly host: EngineHost,
    private readonly deps: SubagentDeps,
  ) {}

  async run(
    parent: LiveSession,
    agent: string,
    prompt: string,
    description: string,
    signal: AbortSignal,
    options: { background?: boolean; isolation?: 'worktree' } = {},
  ): Promise<SubagentResult> {
    const config = this.host.config();
    const slots = this.slotsFor(parent.depth + 1, config.subagents.maxConcurrent);
    const def = this.deps.agent(agent);
    const worktree =
      options.isolation === 'worktree' || def?.isolation === 'worktree'
        ? await this.createWorktree(parent)
        : undefined;
    const child = this.deps.createSession({
      agent,
      title: description,
      parentId: parent.header.id,
      ...(worktree ? { worktree } : {}),
    });
    const limitUsd = def?.budgetUsd ?? config.subagents.budgetUsd;
    if (limitUsd !== undefined) child.budget = { agent, limitUsd };
    const background = options.background === true;
    // Background work outlives the turn that started it; the session cancels it.
    parent.bgController ??= new AbortController();
    const runSignal = background ? parent.bgController.signal : signal;

    const run = async (): Promise<SubagentResult> => {
      await slots.acquire(runSignal);
      try {
        this.host.emit({
          type: 'subagent.started',
          ...scope(parent),
          childSessionId: child.header.id,
          agent,
          task: description,
          ...(background ? { background } : {}),
        });
        // The brief was written with the parent's context, so it's private if that is.
        const inherited = parent.private ? `from its parent: ${parent.private}` : undefined;
        if (inherited) child.private = inherited;
        const result = def?.runtime
          ? await this.deps.runExternal(child, def, prompt, runSignal)
          : await this.deps.runTurn(child, prompt, 'auto', runSignal, {
              ...(inherited ? { private: inherited } : {}),
            });
        const ok = result.stopReason === 'end_turn';
        this.host.emit({
          type: 'subagent.completed',
          ...scope(parent),
          childSessionId: child.header.id,
          agent,
          ok,
          ...(background ? { background } : {}),
        });
        const text = ok ? result.text : `${result.stopReason}: ${child.lastError ?? result.text}`;
        return {
          ok,
          text: worktree ? await finishIsolated(worktree, ok, description, text) : text,
          sessionId: child.header.id,
          ...(child.private && !parent.private
            ? { private: `subagent ${agent}: ${child.private}` }
            : {}),
        };
      } finally {
        slots.release();
      }
    };

    if (!background) return run();
    const done = run()
      .then((r) => {
        // Cancelled with the session: the report is dropped, not delivered.
        if (!runSignal.aborted) this.deliver(parent, child.header.id, agent, description, r);
      })
      .catch(() => {
        // Cancelled with the session: nothing to deliver.
      })
      .finally(() => parent.background.delete(child.header.id));
    parent.background.set(child.header.id, done);
    return { ok: true, text: '', sessionId: child.header.id };
  }

  /** Append waiting background reports as one user message, at a step boundary. */
  drainInbox(s: LiveSession): void {
    if (!s.inbox.length) return;
    this.host.append(s, { role: 'user', parts: s.inbox.splice(0) });
  }

  /**
   * The tightest budget among this session and its ancestors: a nested
   * subagent also counts against every budgeted invocation above it.
   */
  invocationBudget(s: LiveSession): InvocationBudget | undefined {
    let tightest: InvocationBudget | undefined;
    for (let cur: LiveSession | undefined = s; cur; ) {
      if (cur.budget) {
        const spentUsd = this.treeCost(cur.header.id);
        if (!tightest || cur.budget.limitUsd - spentUsd < tightest.limitUsd - tightest.spentUsd)
          tightest = { ...cur.budget, spentUsd };
      }
      cur = cur.header.parentId ? this.host.session(cur.header.parentId) : undefined;
    }
    return tightest;
  }

  /** One pool per depth: a parent holding a slot never waits on its own children. */
  private slotsFor(depth: number, maxConcurrent: number): Semaphore {
    let slots = this.slots.get(depth);
    if (!slots) {
      slots = new Semaphore(maxConcurrent);
      this.slots.set(depth, slots);
    }
    return slots;
  }

  private createWorktree(parent: LiveSession): Promise<Worktree> {
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    return createWorktree(this.host.rootOf(parent), this.worktreeDir(), id).catch((err: Error) => {
      throw new ToolError(err.message);
    });
  }

  /** Worktrees live in the data directory, one folder per repository. */
  private worktreeDir(): string {
    const id = createHash('sha256').update(this.deps.workspaceRoot).digest('hex').slice(0, 12);
    return join(this.deps.dataDir ?? switchbackPaths().dataDir, 'worktrees', id);
  }

  /** Remote spend of a session and all its descendant sessions. */
  private treeCost(sessionId: string): number {
    let total = this.deps.sessionCost(sessionId);
    for (const child of this.deps.children(sessionId)) total += this.treeCost(child.header.id);
    return total;
  }

  /**
   * A background subagent finished: queue its report for the parent. A busy
   * parent picks it up at its next step; an idle top-level session starts a
   * follow-up turn so the agent can act on it.
   */
  private deliver(
    parent: LiveSession,
    childId: string,
    agent: string,
    description: string,
    result: SubagentResult,
  ): void {
    parent.inbox.push({
      type: 'text',
      text: `Background task "${description}" (${agent}) ${result.ok ? 'finished' : 'failed'}:\n\n${result.text || '(no report)'}`,
      backgroundTask: { sessionId: childId, agent, ok: result.ok },
      ...(result.private ? { private: result.private } : {}),
    });
    if (!parent.controller && !parent.header.parentId) {
      void this.deps
        .runTurn(parent, '', 'auto', undefined, { waitForBackground: false })
        .catch((err) => this.host.notify('error', (err as Error).message));
    }
  }
}

/**
 * Turn an isolated subagent's outcome into its report: on success, commit to
 * its branch, remove the worktree, and include the diff; on failure, keep
 * the worktree for inspection.
 */
async function finishIsolated(
  wt: Worktree,
  ok: boolean,
  description: string,
  text: string,
): Promise<string> {
  if (!ok)
    return `${text}\n\nThe worktree is kept for inspection at ${wt.path} (branch ${wt.branch}).`;
  try {
    const r = await finishWorktree(wt, `switchback: ${description}`);
    if (!r.changed) return `${text}\n\n(Isolated in a worktree; it made no file changes.)`;
    return `${text}\n\nChanges are committed on branch \`${wt.branch}\` (from ${wt.base.slice(0, 8)}); your working tree is unchanged. Review and merge them if you want them, e.g. \`git merge ${wt.branch}\`.\n\n${r.stat}\n\n${truncate(r.diff, 20_000)}`;
  } catch (err) {
    return `${text}\n\nCould not finish the worktree (${(err as Error).message}); it is kept at ${wt.path} (branch ${wt.branch}).`;
  }
}
