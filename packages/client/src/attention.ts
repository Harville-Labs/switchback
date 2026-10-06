/**
 * When Switchback needs the user, or has finished something long: shared by
 * both clients so they notify for the same things with the same words. Each
 * client decides how (the TUI asks the terminal, VS Code shows a notification).
 */
import type { EngineEvent, NotificationSettings } from '@switchback/protocol';

export interface Attention {
  /** Why: an answer is needed now, or a long turn is done. */
  kind: 'waiting' | 'done';
  message: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = { mode: 'system', afterSeconds: 30 };

export class AttentionTracker {
  /** When each top-level turn started, by turn ID. */
  private started = new Map<string, number>();

  constructor(
    private readonly settings: NotificationSettings = DEFAULT_NOTIFICATIONS,
    private readonly now: () => number = Date.now,
  ) {}

  /** What to tell the user about this event, if anything. */
  observe(event: EngineEvent): Attention | undefined {
    if (this.settings.mode === 'off') return undefined;
    switch (event.type) {
      case 'permission.requested':
        return {
          kind: 'waiting',
          message: event.plan
            ? 'Switchback has a plan for you to review'
            : `Switchback needs your permission: ${event.summary}`,
        };
      case 'escalation.requested':
        return { kind: 'waiting', message: `Switchback asks to escalate to ${event.target.model}` };
      case 'turn.started':
        if (!event.parentSessionId) this.started.set(event.turnId, this.now());
        return undefined;
      case 'turn.completed': {
        const at = this.started.get(event.turnId);
        this.started.delete(event.turnId);
        if (at === undefined || event.stopReason === 'cancelled') return undefined;
        const seconds = (this.now() - at) / 1000;
        const { afterSeconds } = this.settings;
        if (!afterSeconds || seconds < afterSeconds) return undefined;
        const what = event.stopReason === 'error' ? 'stopped with an error' : 'finished';
        return { kind: 'done', message: `Switchback ${what} (${duration(seconds)})` };
      }
      default:
        return undefined;
    }
  }
}

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
