/**
 * What the engine knows about its models: the live providers, whether each is
 * up, and how much each model's context holds.
 */
import type { EngineEvent, Message, Tier } from '@switchback/protocol';
import { createProvider, type Provider, tierOf } from '@switchback/providers';
import type { ModelInfo } from '@switchback/router';
import type { SwitchbackConfig } from './config.ts';
import { nearThreshold, PER_MESSAGE_OVERHEAD, promptText, promptTokens } from './tokens.ts';

const HEALTH_TTL_OK_MS = 30_000;
const HEALTH_TTL_FAIL_MS = 5_000;
/** Assumed when neither config nor server says; small on purpose so we escalate rather than truncate. */
const UNKNOWN_LOCAL_CONTEXT = 8_192;
const UNKNOWN_REMOTE_CONTEXT = 200_000;
/** Output never clamped below this; a prompt that leaves less is compaction's problem. */
const MIN_OUTPUT_TOKENS = 1_024;

export class ModelDirectory {
  private providers = new Map<string, Provider>();
  /** Provider config each live provider was built from, to rebuild only what changed. */
  private providerConfigs = new Map<string, string>();
  private health = new Map<string, { ok: boolean; at: number }>();
  /** Context windows reported by servers; null means asked and got no answer. */
  private detectedContext = new Map<string, number | null>();

  constructor(
    private config: SwitchbackConfig,
    /** Providers supplied by the embedder (tests); never rebuilt from config. */
    private readonly injected: Map<string, Provider> | undefined,
    private readonly emit: (event: EngineEvent) => void,
    private readonly now: () => Date,
  ) {
    for (const [id, pc] of Object.entries(config.providers)) {
      this.providers.set(id, injected?.get(id) ?? createProvider(id, pc));
      this.providerConfigs.set(id, JSON.stringify(pc));
    }
    for (const [id, p] of injected ?? []) this.providers.set(id, p);
  }

  /** Swap in a new config; providers whose settings didn't change keep their state. */
  apply(next: SwitchbackConfig): void {
    for (const id of [...this.providers.keys()]) {
      if (!next.providers[id] && !this.injected?.has(id)) {
        this.providers.delete(id);
        this.providerConfigs.delete(id);
        this.health.delete(id);
      }
    }
    for (const [id, pc] of Object.entries(next.providers)) {
      const json = JSON.stringify(pc);
      if (this.injected?.has(id) || this.providerConfigs.get(id) === json) continue;
      this.providers.set(id, createProvider(id, pc));
      this.providerConfigs.set(id, json);
      this.health.delete(id);
    }
    this.detectedContext.clear();
    this.config = next;
  }

  provider(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  /** A retryable failure: treat the provider as down until its next health check. */
  markDown(id: string): void {
    this.health.set(id, { ok: false, at: this.now().getTime() });
  }

  tierOfProvider(providerId: string): Tier {
    const pc = this.config.providers[providerId];
    return pc ? tierOf(pc) : (this.providers.get(providerId)?.tier ?? 'remote');
  }

  info(alias: string): ModelInfo | undefined {
    const m = this.config.models[alias];
    if (!m) return undefined;
    return {
      alias,
      ref: { provider: m.provider, model: m.model },
      tier: this.tierOfProvider(m.provider),
      contextWindow: this.contextWindowOf(alias),
      available: this.health.get(m.provider)?.ok ?? true,
    };
  }

  /**
   * Prompt size for routing. A tokenizer estimate, replaced by the local
   * server's exact count when the estimate is close enough to the local
   * threshold that the difference could change the decision.
   */
  async countPrompt(
    system: string,
    messages: Message[],
    specsJson: string,
    signal: AbortSignal,
  ): Promise<number> {
    const estimate = promptTokens(system, messages, specsJson);
    const routing = this.config.routing;
    // With several local models, ask the first reachable one whose threshold
    // is close; the others either clearly fit or clearly don't.
    for (const alias of routing.start) {
      const local = this.info(alias);
      if (local?.tier !== 'local' || !local.available) continue;
      if (!nearThreshold(estimate, local.contextWindow * routing.escalation.contextHeadroom))
        continue;
      const exact = await this.providers
        .get(local.ref.provider)
        ?.countTokens?.(local.ref.model, promptText(system, messages, specsJson), signal)
        .catch(() => undefined);
      // The server counts raw text; add the same per-message template allowance.
      if (exact !== undefined) return exact + PER_MESSAGE_OVERHEAD * messages.length;
    }
    return estimate;
  }

  /** Configured window, else what the server reported, else a conservative guess. */
  contextWindowOf(alias: string): number {
    const m = this.config.models[alias];
    if (m?.contextWindow) return m.contextWindow;
    const detected = this.detectedContext.get(alias);
    if (detected) return detected;
    return m && this.tierOfProvider(m.provider) === 'local'
      ? UNKNOWN_LOCAL_CONTEXT
      : UNKNOWN_REMOTE_CONTEXT;
  }

  /**
   * `maxOutputTokens`, lowered to what the model's known window has left after
   * the prompt. vLLM rejects a request whose prompt plus `max_tokens` exceeds
   * its window, so the 16k default would fail every call to a small one. The
   * prompt count may be an estimate, hence the margin.
   */
  outputBudget(alias: string, inputTokens: number): number {
    const m = this.config.models[alias];
    const configured = m?.maxOutputTokens ?? 16_000;
    const window = m?.contextWindow ?? this.detectedContext.get(alias);
    if (!window) return configured;
    const room = window - Math.ceil(inputTokens * 1.05) - 64;
    return Math.max(MIN_OUTPUT_TOKENS, Math.min(configured, room));
  }

  async refreshHealth(signal: AbortSignal): Promise<void> {
    const now = this.now().getTime();
    const used = new Set(Object.values(this.config.models).map((m) => m.provider));
    await Promise.all(
      [...used].map(async (id) => {
        const cached = this.health.get(id);
        if (cached && now - cached.at < (cached.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_FAIL_MS)) return;
        const provider = this.providers.get(id);
        if (!provider) return;
        const status = await provider.health(signal).catch(() => ({ ok: false }));
        this.health.set(id, { ok: status.ok, at: this.now().getTime() });
      }),
    );
    await this.detectContextWindows();
  }

  /** Ask servers for the context window of models whose config leaves it out (once each). */
  private async detectContextWindows(): Promise<void> {
    await Promise.all(
      Object.entries(this.config.models).map(async ([alias, m]) => {
        if (m.contextWindow || this.detectedContext.has(alias)) return;
        if (!this.health.get(m.provider)?.ok) return;
        const provider = this.providers.get(m.provider);
        // Decision models (the classifier) never hold a prompt that could overflow.
        if (provider?.decisionOnly) return;
        const found = await provider?.contextWindow?.(m.model).catch(() => undefined);
        this.detectedContext.set(alias, found?.contextWindow ?? null);
        this.emit({
          type: 'log',
          level: found ? 'info' : 'warn',
          message: found
            ? `${alias}: context window ${found.contextWindow} (from ${found.source})`
            : `${alias}: context window unknown; assuming ${this.contextWindowOf(alias)}. Set models.${alias}.contextWindow.`,
        });
      }),
    );
  }
}
