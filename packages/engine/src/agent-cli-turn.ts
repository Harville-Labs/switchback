/**
 * A turn on a coding agent CLI model (Claude Code or Codex, as the user is
 * signed in): the CLI works the turn with its own tools and its own session,
 * and its answer joins the transcript like any model's.
 *
 * It gets Switchback's instructions and the tools only Switchback has
 * (subagents, escalate, docs, skills), served over MCP, so it can work the
 * way any model in the session does.
 *
 * The CLI keeps its own context between its turns (its session is resumed),
 * so it's told only what it hasn't seen: what happened since its last turn,
 * as a digest, then the request.
 */
import type { Message, ToolResultPart } from '@switchback/protocol';
import { AgentCliProvider } from '@switchback/providers';
import type { ModelInfo } from '@switchback/router';
import { renderForSummary } from './compaction.ts';
import type { ExternalRuntimes } from './external-runtime.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { AgentCliConfig } from './runtimes/index.ts';
import { switchbackGuide } from './system-prompt.ts';
import type { ToolCall } from './tool-runner.ts';
import { serveTools } from './tool-server.ts';
import { type Tool, type ToolContext, toolSpec } from './tools/index.ts';

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

/**
 * Switchback's tools a CLI gets beside its own: the ones it has no
 * equivalent of. Its own file, shell, web, todo, and plan tools stay its own.
 */
const SHARED_TOOLS = ['task', 'merge_worktree', 'escalate', 'docs', 'skill'];

/** The session's tools, as the agent loop has them for this turn. */
export interface SessionTools {
  tools: Tool[];
  catalog: ToolContext['agentCatalog'];
  /** Runs a call the way a model's calls are run: validated, gated, reported. */
  run(call: ToolCall): Promise<ToolResultPart>;
}

/**
 * What the CLI is told beside its own instructions: how to use Switchback,
 * and the skills it can load.
 */
export function cliInstructions(names: string[], skills: string | undefined): string {
  return [switchbackGuide(names.includes('task')), skills].filter(Boolean).join('\n\n');
}

/** Run the turn on the CLI and record its answer. */
export async function runAgentCliTurn(
  host: EngineHost,
  external: ExternalRuntimes,
  s: LiveSession,
  model: ModelInfo,
  session: SessionTools,
  skills: string | undefined,
  turnId: string,
  signal: AbortSignal,
): Promise<'end_turn' | 'error' | 'cancelled'> {
  const cfg = host.config().providers[model.ref.provider] as AgentCliConfig;
  const prompt = handoffPrompt(s.messages, s.agentSeen?.[model.alias] ?? 0);
  const shared = session.tools.filter((t) => SHARED_TOOLS.includes(t.name));
  const names = shared.map((t) => t.name);
  const server = serveTools(
    shared.map((t) => toolSpec(t, { agentCatalog: session.catalog })),
    (name, input) => session.run({ id: `call_${crypto.randomUUID().slice(0, 8)}`, name, input }),
  );
  const r = await external
    .runAsModel(
      s,
      model,
      cfg,
      {
        prompt,
        instructions: cliInstructions(names, skills),
        tools: { url: server.url, headers: server.headers, names },
      },
      turnId,
      signal,
    )
    .finally(() => server.close());
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
