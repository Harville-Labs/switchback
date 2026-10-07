/**
 * The agents sessions can run as: built-ins plus the user's and project's
 * agent files, reread on use so new agents appear without a restart. A file
 * that can't be used is reported once.
 */
import type { AgentSummary } from '@switchback/protocol';
import { type AgentDefinition, loadAgents, summarize } from './agents.ts';
import type { EngineOptions } from './engine-options.ts';

export class AgentCatalog {
  private agents: Map<string, AgentDefinition>;
  private reported = new Set<string>();

  constructor(
    initial: Map<string, AgentDefinition> | undefined,
    private readonly dirs: EngineOptions['agentDirs'],
    private readonly warn: (message: string) => void,
  ) {
    this.agents = initial ?? loadAgents([]).agents;
  }

  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  all(): AgentDefinition[] {
    return [...this.agents.values()];
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
    this.agents = agents;
    for (const e of errors) {
      if (this.reported.has(e)) continue;
      this.reported.add(e);
      this.warn(`agent definition skipped: ${e}`);
    }
  }
}
