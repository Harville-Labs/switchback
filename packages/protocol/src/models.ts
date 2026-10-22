/**
 * The configured models, asking providers what they serve now
 * (`models.refresh`), and reading the config again (`config.reload`).
 */
import type { ModelRef, Tier } from './transcript.ts';

export interface ModelSummary {
  alias: string;
  ref: ModelRef;
  tier: Tier;
  /**
   * An endpoint or plan lists it but no config file names it. Pickers offer
   * it; cycling with Tab skips it unless a role uses it.
   */
  listed?: true;
}

/** What one provider listed: models new since the last refresh, ones gone, or why it couldn't be asked. */
export interface ModelsRefreshSource {
  provider: string;
  added: string[];
  removed: string[];
  error?: string;
}

export interface ModelsRefreshResult {
  sources: ModelsRefreshSource[];
  /** Every configured model after the refresh. */
  models: ModelSummary[];
}

export interface ConfigReloadResult {
  /** Top-level config keys that changed (`routing`, `models`, ...); empty when nothing did. */
  changed: string[];
  /** Every configured model after the reload. */
  models: ModelSummary[];
}
