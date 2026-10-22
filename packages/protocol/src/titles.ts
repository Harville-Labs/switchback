/**
 * Session titles. A title is session metadata, not a message: renaming never
 * touches the transcript (invariant 4).
 */
import { z } from 'zod';

/** Longest session title: what the session list, tabs, and terminal titles have room for. */
export const SESSION_TITLE_MAX = 60;

/** Who named a session. Only `user` titles are safe from automatic retitling. */
export type TitleSource = 'user' | 'prompt' | 'compaction';

/** A title made from free text (a prompt, a model's suggestion): one line, within the limit. */
export function clipTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > SESSION_TITLE_MAX ? `${line.slice(0, SESSION_TITLE_MAX - 1)}…` : line;
}

export const SessionRenameParams = z.object({
  sessionId: z.string(),
  title: z
    .string()
    .trim()
    .min(1, "can't be empty")
    .max(SESSION_TITLE_MAX, {
      error: (i) => `is ${String(i.input).length} characters; the limit is ${SESSION_TITLE_MAX}`,
    }),
});
export type SessionRenameParams = z.infer<typeof SessionRenameParams>;
