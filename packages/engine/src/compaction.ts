/**
 * Append-only context compaction (ADR 0008). The transcript is never edited:
 * a marker message records a summary and where verbatim history resumes, and
 * every request is built from the latest marker with `contextOf`.
 */
import type { CompactionPart, Message } from '@switchback/protocol';
import { messageTokens } from './tokens.ts';

export function markerOf(m: Message): CompactionPart | undefined {
  const p = m.parts[0];
  return m.role === 'user' && m.parts.length === 1 && p?.type === 'compaction' ? p : undefined;
}

export function latestMarker(
  messages: Message[],
): { index: number; part: CompactionPart } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const part = markerOf(messages[i] as Message);
    if (part) return { index: i, part };
  }
  return undefined;
}

/** One stable object per marker, so per-message token counts stay cached. */
const summaryMessages = new WeakMap<CompactionPart, Message>();

function summaryMessage(part: CompactionPart): Message {
  let m = summaryMessages.get(part);
  if (!m) {
    m = {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: `<conversation_summary>\nEarlier parts of this conversation were compacted. Summary:\n\n${part.summary}\n</conversation_summary>`,
        },
      ],
    };
    summaryMessages.set(part, m);
  }
  return m;
}

/** What a model is sent: the latest summary, then everything from `keepFrom`, minus markers. */
export function contextOf(messages: Message[]): Message[] {
  const latest = latestMarker(messages);
  if (!latest) return messages.filter((m) => !markerOf(m));
  return [
    summaryMessage(latest.part),
    ...messages.slice(latest.part.keepFrom).filter((m) => !markerOf(m)),
  ];
}

/**
 * Where verbatim history should resume: the earliest assistant message such
 * that everything from it to the end fits in `keepTokens`. Starting at an
 * assistant message keeps tool calls with their results and gives valid role
 * alternation after the summary. Undefined when there's nothing worth
 * compacting (fewer than two messages would be summarized).
 */
export function chooseBoundary(
  messages: Message[],
  start: number,
  keepTokens: number,
): number | undefined {
  let kept = 0;
  let i = messages.length;
  while (i > start) {
    const m = messages[i - 1] as Message;
    const n = markerOf(m) ? 0 : messageTokens(m);
    if (kept + n > keepTokens) break;
    kept += n;
    i--;
  }
  let b = i;
  while (b < messages.length && (messages[b] as Message).role !== 'assistant') b++;
  if (b >= messages.length) {
    // Even the last exchange is over budget: keep just the final assistant message.
    b = messages.findLastIndex((m) => m.role === 'assistant');
  }
  return b - start >= 2 ? b : undefined;
}

const TOOL_RESULT_CHARS = 1_500;

/** Plain-text rendering of messages for the summarizer (tool output trimmed). */
export function renderForSummary(messages: Message[]): string[] {
  return messages
    .filter((m) => !markerOf(m))
    .map((m) =>
      m.parts
        .map((p) => {
          if (p.type === 'text')
            return `[${m.role}] ${p.attachment ? `(attached ${p.attachment.path}) ` : ''}${p.text}`;
          if (p.type === 'tool_call')
            return `[tool call] ${p.name} ${JSON.stringify(p.input ?? {})}`;
          if (p.type === 'tool_result') {
            const body =
              p.content.length > TOOL_RESULT_CHARS
                ? `${p.content.slice(0, TOOL_RESULT_CHARS)}\n... (${p.content.length - TOOL_RESULT_CHARS} more characters)`
                : p.content;
            return `[tool result${p.isError ? ', error' : ''}] ${body}`;
          }
          return ''; // reasoning and markers aren't summarized
        })
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean);
}

export const SUMMARIZER_PROMPT = `You compress a coding agent's conversation so the agent can continue the task with less context. Write a summary another instance of the agent can rely on without seeing the original.

Keep:
- The user's requests, quoted exactly when they are instructions or constraints.
- Decisions made and why, and approaches that were tried and rejected.
- Files read, created, or changed, with the important details (paths, function names, what changed).
- Errors seen and how they were resolved, or that they are still open.
- The current state of the task and the concrete next steps.

Drop small talk, redundant tool output, and anything superseded. Use short sections and bullet points. Do not invent details.`;

export function summaryRequest(previous: string | undefined, chunk: string): string {
  return previous
    ? `Summary so far:\n\n${previous}\n\nThe conversation continued as follows. Produce one updated summary covering both.\n\n${chunk}`
    : `Summarize this conversation:\n\n${chunk}`;
}
