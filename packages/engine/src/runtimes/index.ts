/** Builds the configured external agent runtimes (ADR 0009). */
import type { SwitchbackConfig } from '../config.ts';
import { AgentCoreRuntime } from './bedrock-agentcore.ts';
import { ClaudeAgentSdkRuntime } from './claude-agent-sdk.ts';
import { ManagedAgentsRuntime } from './claude-managed-agents.ts';
import { CodexRuntime } from './codex.ts';
import type { AgentRuntime } from './runtime.ts';

export type RuntimeConfig = SwitchbackConfig['runtimes'][string];

export function createRuntime(name: string, cfg: RuntimeConfig): AgentRuntime {
  switch (cfg.type) {
    case 'claude-agent-sdk':
      return new ClaudeAgentSdkRuntime({
        name,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.maxTurns ? { maxTurns: cfg.maxTurns } : {}),
        ...(cfg.executable ? { executable: cfg.executable } : {}),
      });
    case 'claude-managed-agents':
      return new ManagedAgentsRuntime({
        name,
        agent: cfg.agent,
        environment: cfg.environment,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      });
    case 'codex':
      return new CodexRuntime({
        name,
        sandbox: cfg.sandbox,
        network: cfg.network,
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.effort ? { effort: cfg.effort } : {}),
        ...(cfg.executable ? { executable: cfg.executable } : {}),
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      });
    case 'bedrock-agentcore':
      return new AgentCoreRuntime({
        name,
        arn: cfg.arn,
        ...(cfg.qualifier ? { qualifier: cfg.qualifier } : {}),
        ...(cfg.region ? { region: cfg.region } : {}),
      });
  }
}

/**
 * Runtimes that read this workspace without asking about each file. With
 * `privacy.localOnlyPaths` set, nothing could keep them from sending private
 * files to their remote model, so they don't run.
 */
export function readsWorkspaceUnasked(cfg: RuntimeConfig): boolean {
  return cfg.type === 'codex';
}
