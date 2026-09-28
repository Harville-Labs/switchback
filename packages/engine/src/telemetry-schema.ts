/**
 * The telemetry report format (docs/telemetry.md), on its own so receivers
 * (the hosted site) can validate reports without importing the engine.
 */
import { z } from 'zod';

export const TELEMETRY_SCHEMA = 1;

export const DailyReport = z.object({
  schema: z.literal(TELEMETRY_SCHEMA),
  installId: z.string(),
  day: z.string(),
  version: z.string(),
  os: z.string(),
  arch: z.string(),
  calls: z.object({ local: z.number(), remote: z.number() }),
  tokens: z.object({
    local: z.object({ input: z.number(), output: z.number() }),
    remote: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
  }),
  /** Remote spend, estimated savings, and what running it all remote would have cost. */
  costUsd: z.number(),
  savingsUsd: z.number(),
  allRemoteUsd: z.number(),
  byRule: z.record(
    z.string(),
    z.object({ local: z.number(), remote: z.number(), costUsd: z.number() }),
  ),
  /** Remote calls per catalog model ID (`custom` for anything else). */
  remoteModels: z.record(z.string(), z.number()),
  /** Configured provider types, e.g. `ollama`, `anthropic`; never IDs or URLs. */
  providerTypes: z.array(z.string()),
  features: z.object({
    localModels: z.number(),
    remoteModels: z.number(),
    escalationPolicy: z.string(),
    classifier: z.boolean(),
    compaction: z.boolean(),
    privatePaths: z.boolean(),
    secrets: z.string(),
    mcpServers: z.number(),
    runtimes: z.number(),
    budget: z.boolean(),
    organization: z.boolean(),
  }),
  /** How top-level turns ended. */
  turns: z.record(z.string(), z.number()),
  errors: z.number(),
  crashes: z.array(z.object({ name: z.string(), message: z.string(), stack: z.string() })),
});
export type DailyReport = z.infer<typeof DailyReport>;
