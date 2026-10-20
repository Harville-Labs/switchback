/**
 * The agents sessions can run as: built-ins plus the user's and project's
 * agent files, reread on use so new agents appear without a restart, with
 * the config's `agents` entries applied last. A definition that can't be
 * used is reported once.
 */
import type { AgentSummary } from '@switchback/protocol';
import {
  type AgentDefinition,
  applyAgentConfig,
  canDelegate,
  loadAgents,
  summarize,
} from './agents.ts';
import type { SwitchbackConfig } from './config.ts';
import type { EngineOptions } from './engine-options.ts';

export class AgentCatalog {
  private files: Map<string, AgentDefinition>;
  private reported = new Set<string>();
  /** The last result, until the files or the config change. */
  private applied?: {
    files: Map<string, AgentDefinition>;
    config: SwitchbackConfig['agents'];
    agents: Map<string, AgentDefinition>;
  };

  constructor(
    initial: Map<string, AgentDefinition> | undefined,
    private readonly dirs: EngineOptions['agentDirs'],
    private readonly config: () => SwitchbackConfig,
    private readonly warn: (message: string) => void,
  ) {
    this.files = initial ?? loadAgents([]).agents;
  }

  get(name: string): AgentDefinition | undefined {
    return this.current().get(name);
  }

  all(): AgentDefinition[] {
    return [...this.current().values()];
  }

  /** The agents `parent` may delegate to through the task tool. */
  subagentsOf(parent: AgentDefinition): AgentDefinition[] {
    return this.all().filter((a) => canDelegate(parent, a));
  }

  /** `agents.list`, current as of now. */
  list(): AgentSummary[] {
    this.refresh();
    return this.all().map(summarize);
  }

  /** Pick up agent files added or changed since startup (a few small files). */
  refresh(): void {
    if (!this.dirs) return;
    const { agents, errors } = loadAgents(this.dirs);
    this.files = agents;
    for (const e of errors) this.report(`agent definition skipped: ${e}`);
  }

  private current(): Map<string, AgentDefinition> {
    const config = this.config().agents;
    if (this.applied?.files === this.files && this.applied.config === config)
      return this.applied.agents;
    const agents = new Map(this.files);
    for (const [name, entry] of Object.entries(config)) {
      if (entry.disable) {
        agents.delete(name);
        continue;
      }
      try {
        agents.set(name, applyAgentConfig(agents.get(name), name, entry, 'config'));
      } catch (err) {
        this.report(`config agents.${name} skipped: ${(err as Error).message}`);
      }
    }
    this.applied = { files: this.files, config, agents };
    return agents;
  }

  private report(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.warn(message);
  }
}
