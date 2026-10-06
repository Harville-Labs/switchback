/**
 * Review of edits by another model (docs/review.md): remember what each file
 * held before a turn changed it, ask a reviewer about the diff, and hand
 * `revise` findings back to the model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { type RoutePreference, type StopReason, textOf } from '@switchback/protocol';
import type { ChatEvent } from '@switchback/providers';
import type { ModelInfo } from '@switchback/router';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { ModelDirectory } from './model-directory.ts';
import { redactSecrets } from './privacy.ts';
import {
  feedbackText,
  parseReview,
  REVIEWER_PROMPT,
  type ReviewAnswer,
  reviewRequest,
  turnDiff,
} from './review.ts';
import { resolveInWorkspace, toWorkspacePath } from './tools/index.ts';

type Loop = (
  s: LiveSession,
  route: RoutePreference,
  turnId: string,
  signal: AbortSignal,
) => Promise<StopReason>;

export class ReviewRunner {
  constructor(
    private readonly host: EngineHost,
    private readonly models: ModelDirectory,
    /** Runs the agent loop again so the model can address findings. */
    private readonly loop: Loop,
  ) {}

  /** Remember a file's content before its first edit this turn, on the top-level session. */
  noteEdit(s: LiveSession, path: string, writer: string): void {
    const top = this.host.top(s);
    // An isolated subagent's edits are on its own branch, reported with their own diff.
    if (!top.turnEdits || this.host.rootOf(s) !== this.host.rootOf(top)) return;
    let file: string;
    try {
      file = resolveInWorkspace(this.host.rootOf(s), path);
    } catch {
      return; // the tool will report the bad path
    }
    const entry = top.turnEdits.get(file) ?? {
      path: toWorkspacePath(this.host.rootOf(top), file) ?? file,
      before: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
      writers: new Set<string>(),
    };
    entry.writers.add(writer);
    top.turnEdits.set(file, entry);
  }

  /**
   * Review what models changed this turn; on `revise`, hand the findings back
   * and let the model fix them, up to `review.maxRounds` reviews. Reviewers
   * form a ladder: when a reviewer's findings still stand after a fix, the
   * next reviewer takes over.
   */
  async reviewTurn(
    s: LiveSession,
    request: string,
    route: RoutePreference,
    turnId: string,
    signal: AbortSignal,
  ): Promise<StopReason> {
    const rounds = this.host.config().review.maxRounds;
    const ladder = this.ladder(s);
    let stopReason: StopReason = 'end_turn';
    let at = 0;
    let revisedBy = -1;
    for (let round = 1; round <= rounds && !signal.aborted; round++) {
      const edits = [...(s.turnEdits?.entries() ?? [])];
      if (!edits.length) return stopReason;
      const writers = new Set(edits.flatMap(([, e]) => [...e.writers]));
      const diff = turnDiff(
        edits.map(([file, e]) => ({
          path: e.path,
          before: e.before,
          after: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
        })),
      );
      if (!diff) return stopReason;
      const pick = this.pickReviewer(s, ladder, at, writers);
      if ('skip' in pick) {
        this.host.emit({
          type: 'review.completed',
          ...scope(s),
          turnId,
          verdict: 'skipped',
          summary: pick.skip,
          issues: [],
          round,
        });
        return stopReason;
      }
      at = pick.step;
      const result = await this.review(
        s,
        pick.model,
        request,
        diff,
        edits.length,
        round,
        turnId,
        signal,
      );
      if (result?.answer.verdict !== 'revise' || round === rounds) return stopReason;
      // This reviewer already asked for changes once and still does: the next one takes over.
      const escalate = revisedBy === at && at + 1 < ladder.length;
      revisedBy = at;
      if (escalate) at += 1;
      this.host.append(s, {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: feedbackText(result.answer, result.model.ref.model),
            review: { round, model: result.model.ref },
          },
        ],
      });
      stopReason = await this.loop(s, route, turnId, signal);
      if (stopReason !== 'end_turn') return stopReason;
    }
    return stopReason;
  }

  /** Reviewers in order: `review.models`, else the escalation ladder (the session's own, if changed). */
  private ladder(s: LiveSession): string[][] {
    const roles = this.host.rolesOf(s);
    return roles.review.models.length ? roles.review.models : roles.escalate;
  }

  /**
   * The first reviewer from step `from` up that's configured, up, allowed,
   * and didn't write the change; else why none could review.
   */
  private pickReviewer(
    s: LiveSession,
    ladder: string[][],
    from: number,
    writers: Set<string>,
  ): { model: ModelInfo; step: number } | { skip: string } {
    if (!ladder.length)
      return { skip: 'no reviewer is configured (review.models, or a routing.escalate step)' };
    const writerRefs = new Set(
      [...writers].flatMap((a) => {
        const m = this.models.info(a);
        return m ? [`${m.ref.provider}/${m.ref.model}`] : [];
      }),
    );
    let why: string | undefined;
    for (let step = from; step < ladder.length; step++) {
      for (const alias of ladder[step] ?? []) {
        const model = this.models.info(alias);
        if (!model) continue;
        // A model never reviews its own work.
        if (writers.has(alias) || writerRefs.has(`${model.ref.provider}/${model.ref.model}`)) {
          why ??= `${alias} wrote the change, and a model never reviews its own work`;
          continue;
        }
        if (!model.available) {
          why ??= `${alias} is unavailable`;
          continue;
        }
        if (model.tier === 'remote') {
          // Remote review is remote spend: every rule that keeps other calls local applies.
          const blocked = this.host.remoteBlocked(s);
          if (blocked) {
            why ??= blocked;
            continue;
          }
        }
        return { model, step };
      }
    }
    return { skip: why ?? 'no reviewer is available' };
  }

  /** One review call. Never fails the turn: problems are reported as `skipped`. */
  private async review(
    s: LiveSession,
    model: ModelInfo,
    request: string,
    diff: string,
    files: number,
    round: number,
    turnId: string,
    signal: AbortSignal,
  ): Promise<{ answer: ReviewAnswer; model: ModelInfo } | undefined> {
    const skip = (summary: string) => {
      this.host.emit({
        type: 'review.completed',
        ...scope(s),
        turnId,
        verdict: 'skipped',
        summary,
        issues: [],
        round,
        model: model.ref,
      });
      return undefined;
    };
    const config = this.host.config();
    const provider = this.models.provider(model.ref.provider);
    if (!provider) return skip(`provider "${model.ref.provider}" is not configured`);
    const summary = textOf(
      s.messages.findLast((m) => m.role === 'assistant') ?? { role: 'assistant', parts: [] },
    );
    let text = reviewRequest(request, summary, diff);
    // Remote rules (privacy, budget, remote off) were checked when picking the reviewer.
    if (model.tier === 'remote' && config.privacy.secrets !== 'off') {
      const scan = await redactSecrets(text);
      if (scan.found.length && config.privacy.secrets === 'block')
        return skip(`the changes contain a secret (${scan.found[0]})`);
      if (scan.found.length)
        this.host.emit({
          type: 'secrets.redacted',
          ...scope(s),
          kinds: scan.found,
          model: model.ref,
        });
      text = scan.text;
    }
    this.host.emit({
      type: 'route.decided',
      ...scope(s),
      turnId,
      tier: model.tier,
      model: model.ref,
      rule: 'review',
      reason: `reviewing ${files} changed file${files === 1 ? '' : 's'}${round > 1 ? ' (after revisions)' : ''}`,
    });
    const effort = config.models[model.alias]?.effort;
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    try {
      for await (const ev of provider.stream({
        model: model.ref.model,
        system: REVIEWER_PROMPT,
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        tools: [],
        maxTokens: 4_000,
        ...(effort ? { effort } : {}),
        signal,
      })) {
        if (ev.type === 'done') done = ev;
      }
    } catch (err) {
      if (signal.aborted) return undefined;
      return skip(`${model.alias} failed: ${(err as Error).message}`);
    }
    if (!done) return skip(`${model.alias} returned no review`);
    this.host.recordUsage(s, model.tier, model.ref, done.usage, {
      rule: 'review',
      agent: s.header.agent,
    });
    const answer = parseReview(
      done.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
    );
    if (!answer) return skip(`${model.alias}'s review couldn't be read`);
    this.host.emit({
      type: 'review.completed',
      ...scope(s),
      turnId,
      verdict: answer.verdict,
      summary: answer.summary,
      issues: answer.issues,
      model: model.ref,
      round,
    });
    return { answer, model };
  }
}
