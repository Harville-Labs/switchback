import type { AgentDefinition } from './agents.ts';

/**
 * What to tell the model when the agent it knows it works as changed, or
 * undefined when it didn't. Sent with the next prompt as a reminder part,
 * since the system prompt keeps the first agent's text (invariant 7, ADR 0029).
 */
export function agentReminder(
  told: string,
  now: AgentDefinition,
  started: string,
): string | undefined {
  if (told === now.name) return undefined;
  if (now.name === started)
    return `You work as the ${now.name} agent again, as the system prompt describes, with its tools.`;
  const tools = now.tools
    ? `You can use only these tools: ${now.tools.join(', ')}. Calls to others are refused.`
    : 'You can use every tool.';
  return `The user switched you to the ${now.name} agent. Follow its instructions over the system prompt's description of your role:\n\n${now.prompt}\n\n${tools} The user switches agents with Shift+Tab or /agent.`;
}
