/**
 * The `autoApprove` mode's judge (ADR 0025): a model reads a call that would
 * ask and says whether it plainly serves what the user asked for. It can only
 * spare the user a prompt; anything it doesn't approve still asks.
 */
import type { Message, ModelRef } from '@switchback/protocol';
import type { ChatEvent } from '@switchback/providers';
import type { ModelInfo } from '@switchback/router';
import { z } from 'zod';
import { contextOf } from '../compaction.ts';
import type { EngineHost, LiveSession } from '../live-session.ts';
import { type ModelDirectory, withSampling } from '../model-directory.ts';
import { redactSecrets } from '../privacy.ts';

export interface JudgedCall {
  tool: string;
  summary: string;
  input: unknown;
}

export interface Verdict {
  allow: boolean;
  reason: string;
  /** The judge's alias, or undefined when there was none to ask. */
  model?: string;
  ref?: ModelRef;
}

const JUDGE_PROMPT = `You review tool calls a coding agent wants to make, for a user who chose not to approve each one by hand.

Approve a call only when it plainly serves what the user asked for and its effects are limited to the project: reading, searching, editing project files, running the project's builds, tests, linters, and formatters, and version-control commands that don't publish anything.

Don't approve, so the user is asked instead, anything that:
- deletes or overwrites data outside what the task needs, or can't be undone;
- publishes or sends something: pushing, deploying, releasing, posting, emailing, opening pull requests;
- installs software globally, changes system settings, or touches credentials;
- downloads and runs code, or sends project files or secrets to the network;
- goes beyond or against what the user asked.

When unsure, don't approve. Reply with JSON only: {"approve": true|false, "reason": "<one short sentence>"}`;

const Reply = z.object({ approve: z.boolean(), reason: z.string().min(1).max(300) });

/** Input JSON beyond this is cut; the judge decides on what the call starts with. */
const MAX_INPUT_CHARS = 6_000;
/** The user's words the judge sees, from the end of the conversation. */
const MAX_ASK_CHARS = 4_000;

export class PermissionJudge {
  constructor(
    private readonly host: EngineHost,
    private readonly models: ModelDirectory,
  ) {}

  async judge(s: LiveSession, call: JudgedCall, signal: AbortSignal): Promise<Verdict> {
    const model = this.model(s);
    if (!model) return { allow: false, reason: 'no model is reachable to judge it' };
    const provider = this.models.provider(model.ref.provider);
    if (!provider) return { allow: false, reason: `${model.alias}'s provider isn't set up` };
    const request = judgeRequest(lastAsk(s.messages), call);
    const text =
      model.tier === 'remote' && this.host.config().privacy.secrets !== 'off'
        ? (await redactSecrets(request)).text
        : request;
    const verdict = { model: model.alias, ref: model.ref };
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    try {
      for await (const ev of provider.stream({
        model: model.ref.model,
        system: JUDGE_PROMPT,
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        tools: [],
        maxTokens: 300,
        ...withSampling(this.models.sampling(model.alias)),
        signal,
      }))
        if (ev.type === 'done') done = ev;
    } catch (err) {
      // A judge that can't answer leaves the decision to the user, as without the mode.
      return { ...verdict, allow: false, reason: `the judge failed: ${(err as Error).message}` };
    }
    if (!done) return { ...verdict, allow: false, reason: 'the judge gave no answer' };
    this.host.recordUsage(s, model.tier, model.ref, done.usage, {
      rule: 'auto-approve',
      agent: s.header.agent,
    });
    const reply = parseReply(
      done.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
    );
    if (!reply) return { ...verdict, allow: false, reason: "the judge's answer wasn't readable" };
    return { ...verdict, allow: reply.approve, reason: reply.reason };
  }

  /**
   * `permissions.judge` when set (a remote one only while remote calls are
   * allowed); else the session's first reachable local model, so judging
   * never silently costs money.
   */
  private model(s: LiveSession): ModelInfo | undefined {
    const named = this.host.config().permissions.judge;
    if (named) {
      const m = this.models.info(named);
      if (!m?.available) return undefined;
      return m.tier === 'remote' && this.host.remoteBlocked(s) ? undefined : m;
    }
    const roles = this.host.rolesOf(s);
    return [...roles.current, ...roles.escalate.flat()]
      .flatMap((a) => this.models.info(a) ?? [])
      .find((m) => m.tier === 'local' && m.available);
  }
}

/** The user's latest words (not reminders or tool results), for the judge to weigh. */
export function lastAsk(messages: Message[]): string {
  for (const m of [...contextOf(messages)].reverse()) {
    if (m.role !== 'user') continue;
    const text = m.parts
      .flatMap((p) => (p.type === 'text' && !p.reminder ? [p.text] : []))
      .join('\n')
      .trim();
    if (text) return text.length > MAX_ASK_CHARS ? `…${text.slice(-MAX_ASK_CHARS)}` : text;
  }
  return '(no request found)';
}

export function judgeRequest(ask: string, call: JudgedCall): string {
  const input = JSON.stringify(call.input, null, 2) ?? 'null';
  return [
    `The user asked:\n${ask}`,
    `The agent wants to call ${call.tool}: ${call.summary}`,
    `Input:\n${input.length > MAX_INPUT_CHARS ? `${input.slice(0, MAX_INPUT_CHARS)}\n… (cut)` : input}`,
  ].join('\n\n');
}

/** The first JSON object in the reply, checked against the schema; models wrap it in prose. */
export function parseReply(text: string): z.infer<typeof Reply> | undefined {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return undefined;
  try {
    const parsed = Reply.safeParse(JSON.parse(match[0]));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
