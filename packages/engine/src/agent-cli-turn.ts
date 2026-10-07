/**
 * A turn on a coding agent CLI model (Claude Code or Codex, as the user is
 * signed in): the CLI works the turn with its own tools and its own session,
 * and its answer joins the transcript like any model's.
 *
 * The CLI keeps its own context between its turns (its session is resumed),
 * so it's told only what it hasn't seen: what happened since its last turn,
 * as a digest, then the request.
 */
import type { Message } from '@switchback/protocol';
import { AgentCliProvider } from '@switchback/providers';
import type { ModelInfo } from '@switchback/router';
import { renderForSummary } from './compaction.ts';
import type { ExternalRuntimes } from './external-runtime.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { AgentCliConfig } from './runtimes/index.ts';

/** At most this much of the digest is sent (the most recent part). */
const MAX_DIGEST_CHARS = 30_000;

export function isAgentCli(provider: unknown): provider is AgentCliProvider {
  return provider instanceof AgentCliProvider;
}

/**
 * What the CLI is told: the conversation it hasn't seen since `seen` (a
 * message index), split around the latest prompt, then that prompt.
 */
export function handoffPrompt(messages: Message[], seen: number): string {
  const isPrompt = (m: Message) =>
    m.role === 'user' && m.parts.some((p) => p.type === 'text' && !p.reminder && !p.attachment);
  const at = messages.findLastIndex(isPrompt);
  const prompt = (messages[at]?.parts ?? [])
    .flatMap((p) => (p.type === 'text' && !p.reminder ? [p.text] : []))
    .join('\n\n');
  const digest = (from: number, to: number) => {
    const text = renderForSummary(messages.slice(Math.max(seen, from), to)).join('\n');
    return text.length > MAX_DIGEST_CHARS ? `…${text.slice(-MAX_DIGEST_CHARS)}` : text;
  };
  const before = at > seen ? digest(seen, at) : '';
  const since = digest(at + 1, messages.length);
  return [
    before && `Earlier in this conversation, which you haven't seen:\n${before}`,
    since ? `The request:\n${prompt}` : prompt,
    since && `Work done on it so far, before you took over:\n${since}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Run the turn on the CLI and record its answer. */
export async function runAgentCliTurn(
  host: EngineHost,
  external: ExternalRuntimes,
  s: LiveSession,
  model: ModelInfo,
  turnId: string,
  signal: AbortSignal,
): Promise<'end_turn' | 'error' | 'cancelled'> {
  const cfg = host.config().providers[model.ref.provider] as AgentCliConfig;
  const prompt = handoffPrompt(s.messages, s.agentSeen?.[model.alias] ?? 0);
  const r = await external.runAsModel(s, model, cfg, prompt, turnId, signal);
  if (signal.aborted) return 'cancelled';
  if (!r.ok) {
    s.lastError = r.text;
    host.emit({ type: 'error', ...scope(s), turnId, message: `${model.alias}: ${r.text}` });
    return 'error';
  }
  host.append(s, {
    role: 'assistant',
    parts: [{ type: 'text', text: r.text }],
    meta: { model: model.ref, tier: model.tier, routeReason: `${model.alias} worked the turn` },
  });
  s.agentSeen = { ...s.agentSeen, [model.alias]: s.messages.length };
  return 'end_turn';
}
