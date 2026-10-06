/**
 * The organization policy format (docs/organizations.md), on its own so
 * servers (the hosted site) can validate policies without importing the
 * engine.
 */
import type { ProviderConfig } from '@switchback/providers';
import { z } from 'zod';

const PROVIDER_TYPES = [
  'openai-compatible',
  'openai',
  'deepseek',
  'anthropic',
  'bedrock',
  'vertex',
  'anthropic-aws',
  'foundry',
  'azure-openai',
  'typesafe',
  'gemini',
  'mock',
] as const satisfies readonly ProviderConfig['type'][];

export const OrgPolicy = z.object({
  /** Server-assigned revision, shown to users and admins. */
  version: z.union([z.string(), z.number()]).transform(String),
  org: z.object({ id: z.string(), name: z.string() }),
  defaults: z.record(z.string(), z.unknown()).default({}),
  enforced: z.record(z.string(), z.unknown()).default({}),
  restrictions: z
    .object({
      /** false: no remote providers at all; everything runs locally. */
      allowRemote: z.boolean().default(true),
      /** Only these provider types may be used (org- or user-defined). */
      allowedProviderTypes: z.array(z.enum(PROVIDER_TYPES)).optional(),
      /** false: only providers defined by the org policy may be used. */
      allowUserProviders: z.boolean().default(true),
      /** false: only MCP servers defined by the org policy may run. */
      allowUserMcpServers: z.boolean().default(true),
      /**
       * false: only the organization's allow and ask rules apply. Users' and
       * projects' deny rules still do, since they only tighten.
       */
      allowUserPermissionRules: z.boolean().default(true),
      /** false: only hooks defined by the org policy run. */
      allowUserHooks: z.boolean().default(true),
      /** false: sessions can't use the `bypassPermissions` mode. */
      allowBypassPermissions: z.boolean().default(true),
      /** Per-user remote spend caps; users may set lower budgets, never higher. */
      maxDailyUsd: z.number().positive().optional(),
      maxMonthlyUsd: z.number().positive().optional(),
    })
    .prefault({}),
  /** How often clients re-check for updates. */
  refreshSeconds: z.number().int().min(30).max(86_400).default(300),
});
export type OrgPolicy = z.infer<typeof OrgPolicy>;
