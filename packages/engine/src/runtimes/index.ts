/** Builds the configured external agent runtimes (ADR 0009). */
import type { ProviderConfig } from '@switchback/providers';
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

/** The provider types whose models are coding agent CLIs the user is signed in to. */
export type AgentCliConfig = Extract<ProviderConfig, { type: 'claude-code' | 'codex' }>;

/** The runtime that runs a CLI model's turns: `model` is the CLI's own name for the model. */
export function runtimeForModel(
  providerId: string,
  cfg: AgentCliConfig,
  model: string,
): AgentRuntime {
  const executable = cfg.executable ? { executable: cfg.executable } : {};
  return cfg.type === 'claude-code'
    ? new ClaudeAgentSdkRuntime({ name: providerId, model, ...executable })
    : new CodexRuntime({
        name: providerId,
        model,
        sandbox: cfg.sandbox,
        network: cfg.network,
        ...executable,
      });
}
