/** How an engine is built: its workspace, configuration, and what tests or embedders replace. */
import type { Price, Provider } from '@switchback/providers';
import type { AgentDefinition } from './agents.ts';
import type { CheckpointStore } from './checkpoints.ts';
import type { SwitchbackConfig } from './config.ts';
import type { OrgStatus } from './org/policy.ts';
import type { SourcedRule } from './permissions/policy.ts';
import type { AgentRuntime } from './runtimes/runtime.ts';
import type { SessionStore } from './store.ts';
import type { Interaction } from './tool-runner.ts';
import type { BashSandbox } from './tools/sandbox.ts';

export interface EngineOptions {
  workspaceRoot: string;
  config: SwitchbackConfig;
  prices?: Record<string, Price>;
  /** Override provider construction (tests, embedding). Keyed by provider id. */
  providers?: Map<string, Provider>;
  store?: SessionStore;
  /** Where checkpoints (file snapshots for rewinding) are kept; in memory by default. */
  checkpoints?: CheckpointStore;
  /** Where saving a session's roles writes; default: the user config. */
  userConfigFile?: string;
  ledgerFile?: string;
  agents?: Map<string, AgentDefinition>;
  /** External agent runtimes by name, overriding `runtimes` in config (tests, embedding). */
  runtimes?: Map<string, AgentRuntime>;
  /** Where agent files live; rescanned so new agents appear without a restart. */
  agentDirs?: { dir: string; source: AgentDefinition['source'] }[];
  /** Project instructions (the workspace's AGENTS.md). */
  instructions?: string;
  /**
   * How to resolve `ask` permissions and escalations when no client answers.
   * `prompt` emits events and waits (interactive clients); `approve` / `deny`
   * decide immediately (headless runs).
   */
  interaction?: Interaction;
  /** Organization policy in effect, reported to clients. */
  org?: OrgStatus;
  /** Where engine-owned files live (worktrees). Defaults to the switchback data directory. */
  dataDir?: string;
  /** Project MCP servers held back until trusted (from `loadConfig`). */
  untrustedMcp?: { name: string; source: string }[];
  /**
   * The OS sandbox for bash commands (`bash.sandbox`); `false` runs them
   * unsandboxed whatever the config says (tests that exercise other things).
   */
  sandbox?: BashSandbox | false;
  /** Permission rules with their sources (from `loadConfig`); default: the config's, unsourced. */
  rules?: SourcedRule[];
  now?: () => Date;
}
