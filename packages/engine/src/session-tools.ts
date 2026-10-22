import type { AgentDefinition } from './agents.ts';
import type { LiveSession } from './live-session.ts';
import { allowsMcpTool, type McpHub } from './mcp/hub.ts';
import { toolSpec, toolsFor } from './tools/index.ts';

/** A session's tools, the agents it may delegate to, and the tools' specs. */
export function sessionTools(
  s: LiveSession,
  agent: AgentDefinition,
  maxDepth: number,
  deps: { mcp(): McpHub | undefined; subagentsOf(agent: AgentDefinition): AgentDefinition[] },
) {
  const canDelegate = s.depth < maxDepth;
  const mcpTools = (deps.mcp()?.tools() ?? []).filter(
    (t) => !agent.tools || allowsMcpTool(agent.tools, t.name),
  );
  const catalog = deps
    .subagentsOf(agent)
    .filter((a) => a.name !== s.header.agent || s.depth === 0)
    .map((a) => ({ name: a.name, description: a.description }));
  // Built-ins first in their fixed order, then MCP tools by name: a stable cache prefix.
  // No task tool when there's no one to delegate to (`agents: []`, or depth).
  const tools = [...toolsFor(agent.tools, s.depth === 0), ...mcpTools].filter(
    (t) => t.name !== 'task' || (canDelegate && catalog.length > 0),
  );
  const specs = tools.map((t) => toolSpec(t, { agentCatalog: catalog }));
  return { tools, catalog, specs, specsJson: JSON.stringify(specs) };
}
