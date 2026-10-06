/** Drafting a system prompt for a new agent (`switchback agents new`). */
import type { Usage } from '@switchback/protocol';
import type { ChatEvent, Provider } from '@switchback/providers';

export interface AgentSpec {
  name: string;
  purpose: string;
  description: string;
  tools?: string[];
}

/** One tool-free call; returns the draft (possibly empty) and what it used. */
export async function draftAgentPrompt(
  provider: Provider,
  model: string,
  spec: AgentSpec,
  signal: AbortSignal,
): Promise<{ text: string; usage: Usage }> {
  const request = [
    `Write the system prompt for a coding subagent named "${spec.name}".`,
    `Purpose: ${spec.purpose}`,
    `The parent agent delegates to it when: ${spec.description}`,
    `Tools it can use: ${spec.tools?.join(', ') ?? 'all tools (read, glob, grep, edit, write, bash, task, and MCP tools)'}`,
    'It starts with no conversation history and must return one final report to the parent.',
    'Write in the second person ("You are..."). Cover how to approach the work, what to check, what not to do, and exactly what the final report should contain. Plain text, no preamble, under 250 words.',
  ].join('\n');
  let done: Extract<ChatEvent, { type: 'done' }> | undefined;
  for await (const ev of provider.stream({
    model,
    system: 'You write concise, specific system prompts for software engineering agents.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: request }] }],
    tools: [],
    maxTokens: 2_000,
    signal,
  })) {
    if (ev.type === 'done') done = ev;
  }
  if (!done) throw new Error('the model returned no draft');
  const text = done.parts
    .flatMap((p) => (p.type === 'text' ? [p.text] : []))
    .join('')
    .trim();
  // Empty or not, the call was made and is billed.
  return { text, usage: done.usage };
}
