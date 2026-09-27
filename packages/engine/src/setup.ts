/**
 * Config setup: turn setup answers into a config layer. Server detection
 * lives in @harness/providers (it's also used at runtime). Used by `harness init`; kept here (not in the CLI) so any
 * client can drive setup through the same logic.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  deepMerge,
  defaultConfig,
  HarnessConfig,
  referenceProblem,
  stripJsonComments,
} from './config.ts';

export {
  type DetectedModel,
  type DetectedServer,
  detectLocalServers,
  KNOWN_SERVERS,
  type LocalServerKind,
  OLLAMA_DEFAULT_CONTEXT,
} from '@harness/providers';

// ---------------------------------------------------------------------------
// Answers -> config
// ---------------------------------------------------------------------------

export const REMOTE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const;

export interface SetupAnswers {
  local?: {
    providerId: string;
    baseUrl: string;
    model: string;
    contextWindow: number;
    apiKeyEnv?: string;
  };
  remote:
    | { kind: 'none' }
    | { kind: 'anthropic'; model: string }
    | { kind: 'bedrock'; model: string; region: string; profile?: string }
    | { kind: 'vertex'; model: string; projectId: string; region: string };
  escalationPolicy: 'auto' | 'ask' | 'off';
  budget?: { dailyUsd?: number; monthlyUsd?: number };
}

const CONTEXT: Record<string, number> = {
  'claude-opus-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

/** Build the config layer described by the answers. */
export function buildSetupConfig(a: SetupAnswers): Record<string, unknown> {
  if (!a.local && a.remote.kind === 'none') {
    throw new Error('configure at least a local model or a remote provider');
  }
  const providers: Record<string, unknown> = {};
  const models: Record<string, unknown> = {};
  const routing: Record<string, unknown> = { escalation: { policy: a.escalationPolicy } };

  if (a.local) {
    providers[a.local.providerId] = {
      type: 'openai-compatible',
      baseUrl: a.local.baseUrl,
      tier: 'local',
      ...(a.local.apiKeyEnv ? { apiKey: `{env:${a.local.apiKeyEnv}}` } : {}),
    };
    models.local = {
      provider: a.local.providerId,
      model: a.local.model,
      contextWindow: a.local.contextWindow,
    };
  }

  const r = a.remote;
  if (r.kind !== 'none') {
    const id = r.kind;
    providers[id] =
      r.kind === 'anthropic'
        ? { type: 'anthropic' }
        : r.kind === 'bedrock'
          ? { type: 'bedrock', region: r.region, ...(r.profile ? { profile: r.profile } : {}) }
          : { type: 'vertex', projectId: r.projectId, region: r.region };
    // Bedrock model IDs carry the `anthropic.` prefix; the API and Vertex use bare IDs.
    const wire = (m: string) => (r.kind === 'bedrock' ? `anthropic.${m}` : m);
    const entry = (m: string) => ({
      provider: id,
      model: wire(m),
      contextWindow: CONTEXT[m] ?? 200_000,
      ...(m === 'claude-haiku-4-5' ? {} : { maxOutputTokens: 32_000 }),
    });
    models.remote = entry(r.model);
    // Claude Code agent aliases follow the chosen platform.
    models.opus = entry('claude-opus-5');
    models.sonnet = entry('claude-sonnet-5');
    models.haiku = entry('claude-haiku-4-5');
  }

  // Always explicit, so re-running setup replaces a previous mode.
  routing.mode = !a.local ? 'remote-only' : r.kind === 'none' ? 'local-only' : 'auto';
  if (a.budget?.dailyUsd || a.budget?.monthlyUsd) {
    routing.budget = {
      ...(a.budget.dailyUsd ? { dailyUsd: a.budget.dailyUsd } : {}),
      ...(a.budget.monthlyUsd ? { monthlyUsd: a.budget.monthlyUsd } : {}),
    };
  }
  return { providers, models, routing };
}

export interface WriteResult {
  file: string;
  backup?: string;
  config: Record<string, unknown>;
}

/**
 * Merge a layer into a config file (creating it if needed), validating the
 * result against the schema first. Existing files are backed up to `.bak`
 * because rewriting drops comments.
 */
export function writeConfigLayer(file: string, layer: Record<string, unknown>): WriteResult {
  let existing: Record<string, unknown> = {};
  let backup: string | undefined;
  if (existsSync(file)) {
    existing = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  const merged = deepMerge(existing, layer);
  const check = HarnessConfig.safeParse(deepMerge(defaultConfig(), merged));
  const problem = check.success
    ? referenceProblem(check.data)
    : check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  if (problem) throw new Error(`setup produced an invalid config: ${problem}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return { file, ...(backup ? { backup } : {}), config: merged };
}
