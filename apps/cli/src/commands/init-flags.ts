/** Flags for `switchback init`; every question has one, so setup can run unattended. */
import type { RemoteKind } from '@switchback/engine';

export interface InitFlags {
  cwd: string;
  yes: boolean;
  scope?: 'user' | 'project';
  /** Extra server URLs to probe. */
  localUrls: string[];
  /** Local models in order of preference; `contextWindows` pairs with them by position. */
  localModels: string[];
  contextWindows: number[];
  /** Roles by alias or model ID; defaults from `defaultRoles`. `start` is a chain. */
  start?: string[];
  /** Escalation steps in order; each an alias, or a comma-separated chain. */
  escalate?: string[];
  /** `off`, `ladder` (the escalation ladder), or comma-separated reviewers in order. */
  reviewers?: string;
  /** Default model for subagents. */
  subagentModel?: string;
  noLocal: boolean;
  /** Remote providers in order of preference; `remoteModels` pairs with them by position. */
  remotes: (RemoteKind | 'none')[];
  remoteModels: string[];
  /** openai-compatible remote only. */
  remoteUrl?: string;
  remoteKeyEnv?: string;
  remoteContextWindow?: number;
  region?: string;
  profile?: string;
  projectId?: string;
  /** Claude Platform on AWS. */
  workspaceId?: string;
  /** Microsoft Foundry or Azure OpenAI resource name. */
  resource?: string;
  /** Azure OpenAI deployment name. */
  deployment?: string;
  /** Azure OpenAI sign-in. */
  azureAuth?: 'key' | 'entra';
  policy?: 'auto' | 'ask' | 'off';
  dailyBudget?: number;
  monthlyBudget?: number;
  /** Anonymous usage statistics; always written to the user config. */
  telemetry?: boolean;
}

/** A problem with the answers or flags; reported as a usage error, not a crash. */
export class SetupError extends Error {}
