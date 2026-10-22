/**
 * What agents add to the permission gate (ADR 0029). A top-level session is
 * offered every tool whichever agent it works as, so the gate holds each call
 * to the active agent's `tools`. And an agent's `permissions` tighten the
 * config's: a stricter category level, and ask and deny rules.
 */
import { type AgentDefinition, canDelegate, stricter } from '../agents.ts';
import type { CategoryLevel } from '../config-schema.ts';
import { allowsMcpTool } from '../mcp/tools.ts';
import { ALL_TOOLS, toolsFor } from '../tools/index.ts';
import { PermissionPolicy, type RuleVerdict, type ToolCall } from './policy.ts';

/** Why the active agent may not make this call, or undefined when it may. */
export function agentRefusal(
  agent: AgentDefinition,
  call: { name: string; input: unknown },
  lookup: (name: string) => AgentDefinition | undefined,
): string | undefined {
  if (!usesTool(agent, call.name))
    return `The ${agent.name} agent can't use ${call.name}. Work with the tools it has; if the task needs ${call.name}, tell the user, who can switch agents (Shift+Tab or /agent).`;
  const childName = call.name === 'task' ? (call.input as { agent?: unknown })?.agent : undefined;
  const child = typeof childName === 'string' ? lookup(childName) : undefined;
  if (child && !canDelegate(agent, child))
    return `The ${agent.name} agent can't delegate to ${child.name}. Pick another agent, or do the work directly.`;
  return undefined;
}

function usesTool(agent: AgentDefinition, name: string): boolean {
  if (!agent.tools) return true;
  if (ALL_TOOLS.some((t) => t.name === name))
    return toolsFor(agent.tools, true).some((t) => t.name === name);
  if (name.startsWith('mcp__')) return allowsMcpTool(agent.tools, name);
  return agent.tools.includes(name.toLowerCase());
}

type Category = 'read' | 'edit' | 'bash' | 'web' | 'mcp';

/** The strictest level these agents set for a category, and the agent that set it. */
export function agentLevel(
  agents: AgentDefinition[],
  category: Category,
): { level: CategoryLevel; agent: AgentDefinition } | undefined {
  let found: { level: CategoryLevel; agent: AgentDefinition } | undefined;
  for (const agent of agents) {
    const level = agent.permissions?.[category];
    if (level && (!found || stricter(found.level, level) !== found.level)) found = { level, agent };
  }
  return found;
}

/** What the model hears when an agent's level turns a category off. */
export function agentDenied(agent: AgentDefinition, tool: string, category: Category): string {
  const plan = agent.tools?.includes('exit_plan_mode')
    ? ' Finish the plan and present it with exit_plan_mode; once the user approves it, you can make changes.'
    : '';
  return `The ${agent.name} agent can't use ${tool} (its permissions.${category} is deny).${plan}`;
}

/** Agents' ask and deny rules, compiled once per definition. */
export class AgentPolicies {
  private compiled = new WeakMap<AgentDefinition, PermissionPolicy>();

  /** The first agent rule that denies this call, else the first that asks. */
  evaluate(agents: AgentDefinition[], call: ToolCall, root: string): RuleVerdict | undefined {
    const verdicts = agents
      .map((a) => this.policy(a)?.evaluate(call, root))
      .filter((v): v is RuleVerdict => !!v && v.behavior !== 'allow');
    return verdicts.find((v) => v.behavior === 'deny') ?? verdicts[0];
  }

  private policy(agent: AgentDefinition): PermissionPolicy | undefined {
    const { ask = [], deny = [] } = agent.permissions ?? {};
    if (!ask.length && !deny.length) return undefined;
    let policy = this.compiled.get(agent);
    if (!policy) {
      const source = `agent ${agent.name}`;
      policy = new PermissionPolicy([
        ...deny.map((rule) => ({ rule, behavior: 'deny' as const, source })),
        ...ask.map((rule) => ({ rule, behavior: 'ask' as const, source })),
      ]);
      this.compiled.set(agent, policy);
    }
    return policy;
  }
}
