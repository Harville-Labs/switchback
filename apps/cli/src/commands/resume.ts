/** `switchback resume [id]`: which session the TUI opens on, and how to get back to it after. */
import { resumeHint } from '@switchback/client';
import type { SessionSummary } from '@switchback/protocol';

/** With no id, the TUI opens on the session picker; with one, on that session. */
export function resumeOptions(
  id: string | undefined,
): { opening: 'sessions' } | { resume: string } {
  return id === undefined ? { opening: 'sessions' } : { resume: id };
}

/**
 * The session to open for `--continue` (`latest`) or an id, from this workspace's sessions.
 * No id means start a new session. An id that isn't one of them is an error, checked
 * before the TUI draws so the message stays on screen.
 */
export function resumeTarget(
  resume: string,
  sessions: readonly SessionSummary[],
): { sessionId?: string; error?: string } {
  if (resume === 'latest') return sessions[0] ? { sessionId: sessions[0].id } : {};
  if (sessions.some((s) => s.id === resume)) return { sessionId: resume };
  return {
    error: `no session in this workspace has the id "${resume}"; \`switchback resume\` opens a list to pick from, and \`switchback sessions\` prints the ids`,
  };
}

/** The line left in the terminal on leaving the TUI; a session with nothing in it has nothing to resume. */
export function exitHint(sessionId: string, messages: number): string | undefined {
  return messages > 0 ? resumeHint(sessionId) : undefined;
}
