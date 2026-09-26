import type { Message } from '@harness/protocol';

/**
 * Cheap token estimate for routing decisions (~4 chars/token, rounded up).
 * Deliberately conservative; it only has to decide whether a turn fits the
 * local context window, not bill anyone.
 */
export function estimateTokens(system: string, messages: Message[], toolSchemaChars = 0): number {
  let chars = system.length + toolSchemaChars;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') chars += p.text.length;
      else if (p.type === 'tool_result') chars += p.content.length;
      else chars += p.name.length + JSON.stringify(p.input ?? {}).length;
    }
  }
  return Math.ceil(chars / 4);
}
