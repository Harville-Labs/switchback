/**
 * Append-only compaction (ADR 0008): when a prompt grows past the threshold,
 * summarize older history into a marker appended to the transcript.
 */
import type { Message } from '@switchback/protocol';
import type { ChatEvent, Provider } from '@switchback/providers';
import { type ModelInfo, roleAliases } from '@switchback/router';
import {
  chooseBoundary,
  contextOf,
  latestMarker,
  renderForSummary,
  SUMMARIZER_PROMPT,
  summaryRequest,
} from './compaction.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { ModelDirectory } from './model-directory.ts';
import { redactSecrets } from './privacy.ts';
import { countTokens, promptTokens } from './tokens.ts';

export class Compactor {
  constructor(
    private readonly host: EngineHost,
    private readonly models: ModelDirectory,
  ) {}

  /**
   * Summarize older history into an appended marker when the prompt passes the
   * threshold (or always, when forced). Returns whether a marker was written.
   */
  async compact(
    s: LiveSession,
    specsJson: string,
    signal: AbortSignal,
    force: boolean,
    turnId?: string,
  ): Promise<boolean> {
    const cfg = this.host.config().compaction;
    const window = this.window();
    if (!window) return false;
    const before = promptTokens(s.header.system, contextOf(s.messages), specsJson);
    if (!force && before < window * cfg.threshold) return false;

    const latest = latestMarker(s.messages);
    const start = latest ? latest.part.keepFrom : 0;
    // On request, compact meaningfully even far below the threshold.
    const keep = force ? Math.min(window * cfg.keepRecent, before * 0.25) : window * cfg.keepRecent;
    const keepFrom = chooseBoundary(s.messages, start, keep);
    if (keepFrom === undefined) return false;

    const summarizer = this.summarizerModel(before, s);
    if (!summarizer) {
      this.host.notify('warn', 'context is large but no model is available to summarize it');
      return false;
    }
    const provider = this.models.provider(summarizer.ref.provider);
    if (!provider) return false;
    if (summarizer.tier === 'remote' && turnId)
      this.host.emit({
        type: 'route.decided',
        ...scope(s),
        turnId,
        tier: 'remote',
        model: summarizer.ref,
        rule: 'compaction',
        reason: 'no local model is reachable to summarize earlier context',
      });

    const summary = await this.summarizeRange(s, provider, summarizer, start, keepFrom, signal);
    if (!summary || signal.aborted) return false;

    const marker: Message = {
      role: 'user',
      parts: [{ type: 'compaction', summary, keepFrom, tokensBefore: before, tokensAfter: 0 }],
    };
    const part = marker.parts[0] as Extract<Message['parts'][number], { type: 'compaction' }>;
    part.tokensAfter = promptTokens(s.header.system, contextOf([...s.messages, marker]), specsJson);
    this.host.append(s, marker);
    this.host.emit({
      type: 'context.compacted',
      ...scope(s),
      messages: keepFrom - start,
      tokensBefore: before,
      tokensAfter: part.tokensAfter,
    });
    return true;
  }

  /**
   * Local first: the first reachable local model. A remote model only when
   * routing allows remote and the budget isn't spent (local never silently
   * costs money).
   */
  summarizerModel(tokens: number, s?: LiveSession): ModelInfo | undefined {
    const inRoles = roleAliases(this.host.config().routing).flatMap(
      (a) => this.models.info(a) ?? [],
    );
    const local = inRoles.find((m) => m.tier === 'local' && m.available);
    if (local) return local;
    if (this.host.remoteBlocked(s)) return undefined;
    return inRoles.find(
      (m) => m.tier === 'remote' && m.available && m.contextWindow > Math.min(tokens, 16_000),
    );
  }

  /**
   * The window compaction keeps a session inside: the largest in the start
   * chain, so turns can always go back to it; else the first escalation step's.
   */
  private window(): number | undefined {
    const routing = this.host.config().routing;
    const start = routing.start.flatMap((a) => this.models.info(a) ?? []);
    if (start.length) return Math.max(...start.map((m) => m.contextWindow));
    const first = (routing.escalate[0] ?? []).flatMap((a) => this.models.info(a) ?? [])[0];
    return first?.contextWindow;
  }

  /** Fold chunks that fit the summarizer's window into a running summary. */
  private async summarizeRange(
    s: LiveSession,
    provider: Provider,
    summarizer: ModelInfo,
    start: number,
    keepFrom: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const budget = Math.floor(summarizer.contextWindow * 0.5);
    let summary = latestMarker(s.messages)?.part.summary;
    let chunk: string[] = [];
    let chunkTokens = 0;
    const flush = async () => {
      if (!chunk.length) return;
      summary = await this.summarize(s, provider, summarizer, summary, chunk.join('\n\n'), signal);
      chunk = [];
      chunkTokens = 0;
    };
    for (const block of renderForSummary(s.messages.slice(start, keepFrom))) {
      const n = countTokens(block);
      const text = n > budget ? `${block.slice(0, budget * 3)}\n... (truncated)` : block;
      if (chunkTokens + Math.min(n, budget) > budget) await flush();
      chunk.push(text);
      chunkTokens += Math.min(n, budget);
    }
    await flush();
    return summary;
  }

  private async summarize(
    s: LiveSession,
    provider: Provider,
    model: ModelInfo,
    previous: string | undefined,
    chunk: string,
    signal: AbortSignal,
  ): Promise<string> {
    const request = summaryRequest(previous, chunk);
    const text =
      model.tier === 'remote' && this.host.config().privacy.secrets !== 'off'
        ? (await redactSecrets(request)).text
        : request;
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    for await (const ev of provider.stream({
      model: model.ref.model,
      system: SUMMARIZER_PROMPT,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
      tools: [],
      maxTokens: 4_000,
      signal,
    })) {
      if (ev.type === 'done') done = ev;
    }
    if (!done) throw new Error(`${provider.id} ended the summary without a result`);
    this.host.recordUsage(s, model.tier, model.ref, done.usage, {
      rule: 'compaction',
      agent: s.header.agent,
    });
    const summary = done.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    if (!summary) throw new Error(`${model.alias} returned an empty summary`);
    return summary;
  }
}
