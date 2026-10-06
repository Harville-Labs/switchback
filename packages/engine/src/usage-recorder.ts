import type { EngineEvent, ModelRef, Tier, Usage } from '@switchback/protocol';
import type { UsageLedger } from './ledger.ts';
import { type LiveSession, scope } from './live-session.ts';

/** Shortest cache lifetime among providers (Anthropic's default TTL). */
const CACHE_TTL_MS = 5 * 60_000;
/**
 * Below this, a miss can be normal (providers only cache prompts above a
 * model-specific minimum), so it isn't worth a warning.
 */
const CACHE_CHECK_MIN_TOKENS = 4_096;

/** Every model call goes to the ledger, and the session's running cost goes to clients. */
export class UsageRecorder {
  constructor(
    private readonly ledger: UsageLedger,
    private readonly emit: (event: EngineEvent) => void,
    private readonly now: () => Date,
  ) {}

  record(
    s: LiveSession,
    tier: Tier,
    model: ModelRef,
    usage: Usage,
    meta: { rule: string; agent: string; costUsd?: number; decodeMs?: number },
  ): void {
    this.ledger.record(s.header.id, tier, model, usage, meta);
    if (tier === 'remote') this.checkCache(s, model, usage);
    const total = this.ledger.sessionCost(s.header.id);
    this.emit({
      type: 'usage.updated',
      ...scope(s),
      usage: total.usage,
      costUsd: total.costUsd,
      savingsUsd: total.savingsUsd,
      tier,
    });
  }

  /**
   * Consecutive calls to one remote model within the cache lifetime share a
   * prefix (append-only transcript, frozen system prompt, fixed tool order),
   * so they should read from the provider's cache. A miss means something is
   * changing the prefix and every call is paying full price; say so once.
   */
  private checkCache(s: LiveSession, model: ModelRef, usage: Usage): void {
    const key = `${model.provider}/${model.model}`;
    const at = this.now().getTime();
    const prev = s.lastRemote;
    s.lastRemote = { key, at };
    if (s.cacheWarned || !prev || prev.key !== key || at - prev.at > CACHE_TTL_MS) return;
    const read = usage.cacheReadTokens ?? 0;
    const prompt = usage.inputTokens + read + (usage.cacheWriteTokens ?? 0);
    if (read > 0 || prompt < CACHE_CHECK_MIN_TOKENS) return;
    s.cacheWarned = true;
    this.emit({
      type: 'log',
      level: 'warn',
      message: `${key}: no prompt-cache hit on a follow-up call (${prompt} input tokens at full price). The provider may not cache this model, or the prompt prefix is changing between calls.`,
    });
  }
}
