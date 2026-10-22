/**
 * Append-only compaction (ADR 0008): when a prompt grows past the threshold,
 * summarize older history into a marker appended to the transcript.
 */
import {
  type AutoCompactStatus,
  clipTitle,
  ErrorCode,
  type Message,
  RpcError,
  type SessionSetAutoCompactParams,
} from '@switchback/protocol';
import type { ChatEvent, Provider } from '@switchback/providers';
import { type ModelInfo, roleAliases } from '@switchback/router';
import {
  chooseBoundary,
  contextOf,
  latestMarker,
  renderForSummary,
  SUMMARIZER_PROMPT,
  splitTitle,
  summaryRequest,
} from './compaction.ts';
import {
  chunkBlocks,
  groupsOf,
  historyRecord,
  mergeCalls,
  mergeRequest,
  partRequest,
  staleCalls,
  withoutRecord,
} from './compaction-digest.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import { type ModelDirectory, withSampling } from './model-directory.ts';
import { redactSecrets } from './privacy.ts';
import { writeConfigLayer } from './setup.ts';
import { promptTokens } from './tokens.ts';

/** Summarizer calls in flight at once while parts are summarized. */
const PARALLEL_PARTS = 2;
/** The most a part's summary can be (the summarizer's `maxTokens`). */
const SUMMARY_TOKENS = 4_000;

export class Compactor {
  constructor(
    private readonly host: EngineHost,
    private readonly models: ModelDirectory,
  ) {}

  /** `session.compact`: compact now, whatever the prompt size; refused while a turn runs. */
  async compactNow(s: LiveSession, toolSpecsJson: () => string): Promise<boolean> {
    if (s.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is running a turn');
    const controller = new AbortController();
    s.controller = controller;
    try {
      await this.models.refreshHealth(controller.signal);
      return await this.compact(s, toolSpecsJson(), controller.signal, true);
    } finally {
      s.controller = undefined;
    }
  }

  /** Whether turns in this session compact on their own: `/autocompact`, else config. */
  autoEnabled(s: LiveSession): boolean {
    return this.host.top(s).autoCompact ?? this.host.config().compaction.enabled;
  }

  /** `session.setAutoCompact`. With `save`, `userConfigFile` gets it as the default. */
  setAuto(
    s: LiveSession,
    params: SessionSetAutoCompactParams,
    userConfigFile: string,
  ): AutoCompactStatus {
    const top = this.host.top(s);
    if (params.enabled !== undefined) top.autoCompact = params.enabled;
    const enabled = this.autoEnabled(top);
    if (params.save) writeConfigLayer(userConfigFile, { compaction: { enabled } });
    const window = this.window();
    return {
      enabled,
      threshold: this.host.config().compaction.threshold,
      ...(window ? { window } : {}),
      ...(params.save ? { savedTo: userConfigFile } : {}),
    };
  }

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

    let summary: string | undefined;
    let title: string | undefined;
    try {
      ({ summary, title } = await this.summarizeRange(
        s,
        provider,
        summarizer,
        start,
        keepFrom,
        signal,
      ));
    } finally {
      this.host.emit({ type: 'context.compacting', ...scope(s), phase: 'end', done: 0, total: 0 });
    }
    if (!summary || signal.aborted) return false;
    // The record covers all compacted history, so it's rebuilt rather than summarized again.
    const record = historyRecord(s.messages.slice(0, keepFrom));
    if (record) summary = `${summary}\n\n${record}`;

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
    // The summary's title, from the same call: retitling costs nothing more.
    // A title the user chose stays; subagent sessions keep their task's name.
    if (title && !s.header.parentId && s.header.titleSource !== 'user')
      this.host.rename(s, clipTitle(title), 'compaction');
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
  window(): number | undefined {
    const routing = this.host.config().routing;
    const start = routing.current.flatMap((a) => this.models.info(a) ?? []);
    if (start.length) return Math.max(...start.map((m) => m.contextWindow));
    const first = (routing.escalate[0] ?? []).flatMap((a) => this.models.info(a) ?? [])[0];
    return first?.contextWindow;
  }

  /**
   * Map, then reduce: each part of the history that fits the summarizer is
   * summarized on its own (a few at a time), then the summaries, after the
   * previous marker's, are merged in groups until one is left. Unlike folding
   * parts into a running summary, early parts aren't rewritten once per later
   * part, so they lose less. One part is a single call, as before.
   */
  private async summarizeRange(
    s: LiveSession,
    provider: Provider,
    summarizer: ModelInfo,
    start: number,
    keepFrom: number,
    signal: AbortSignal,
  ): Promise<{ summary?: string; title?: string }> {
    const budget = Math.floor(summarizer.contextWindow * 0.5);
    const previous = latestMarker(s.messages)?.part.summary;
    const prior = previous === undefined ? undefined : withoutRecord(previous);
    const stale = staleCalls(s.messages.slice(0, keepFrom));
    const chunks = chunkBlocks(renderForSummary(s.messages.slice(start, keepFrom), stale), budget);
    if (!chunks.length) return { summary: prior };
    const call = (request: string) => this.summarize(s, provider, summarizer, request, signal);
    const progress = (phase: 'summarize' | 'merge', done: number, total: number) =>
      this.host.emit({ type: 'context.compacting', ...scope(s), phase, done, total });

    if (chunks.length === 1) {
      progress('summarize', 0, 1);
      return splitTitle(await call(summaryRequest(prior, chunks[0] as string)));
    }
    const size = Math.max(2, Math.floor(budget / SUMMARY_TOKENS));
    const total = chunks.length + mergeCalls(chunks.length + (prior ? 1 : 0), size);
    let done = 0;
    progress('summarize', done, total);
    const parts: string[] = [];
    for (const [g, group] of groupsOf(chunks, PARALLEL_PARTS).entries()) {
      const out = await Promise.all(
        group.map(async (chunk, i) => {
          const at = g * PARALLEL_PARTS + i;
          const text = await call(partRequest(at + 1, chunks.length, chunk));
          progress('summarize', ++done, total);
          return splitTitle(text).summary;
        }),
      );
      parts.push(...out);
      if (signal.aborted) return {};
    }
    let level = prior ? [prior, ...parts] : parts;
    let last: { summary: string; title?: string } = { summary: level[0] as string };
    while (level.length > 1) {
      const next: string[] = [];
      for (const group of groupsOf(level, size)) {
        if (group.length === 1) {
          next.push(group[0] as string);
          continue;
        }
        last = splitTitle(await call(mergeRequest(group)));
        progress('merge', ++done, total);
        next.push(last.summary);
      }
      level = next;
    }
    return last;
  }

  private async summarize(
    s: LiveSession,
    provider: Provider,
    model: ModelInfo,
    request: string,
    signal: AbortSignal,
  ): Promise<string> {
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
      maxTokens: SUMMARY_TOKENS,
      ...withSampling(this.models.sampling(model.alias)),
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
