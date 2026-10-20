/**
 * The sessions one client opened, and their subagents. A shared daemon sends
 * every attached client every session's events (the dashboard shows sessions
 * working in other windows), so anything that acts on an event outside a
 * tab's view, like a notification or an editor opened for review, asks this
 * first. Otherwise a terminal chat's permission prompt pops up in VS Code.
 */
import type { EngineEvent } from '@switchback/protocol';

export class SessionScope {
  private readonly ids = new Set<string>();

  /** Claim a session this client created or opened in a tab. */
  add(sessionId: string): void {
    this.ids.add(sessionId);
  }

  /**
   * Follow subagents of the sessions claimed here, and say whether the event
   * belongs to one of them. Call it for every event, in order; repeat calls
   * are harmless. Events that aren't about a session belong to everyone.
   */
  observe(event: EngineEvent): boolean {
    if (!('sessionId' in event)) return true;
    if (event.parentSessionId && this.ids.has(event.parentSessionId)) this.ids.add(event.sessionId);
    if (event.type === 'subagent.started' && this.ids.has(event.sessionId))
      this.ids.add(event.childSessionId);
    return this.ids.has(event.sessionId);
  }
}
