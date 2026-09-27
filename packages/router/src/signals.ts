/**
 * Per-session quality signals that feed escalation. The engine reports what
 * happened on each turn; the router reads a snapshot when routing the next one.
 */
import type { Tier } from '@harness/protocol';
import stableStringify from 'safe-stable-stringify';
import type { EscalationConfig } from './config.ts';

export interface SignalSnapshot {
  consecutiveToolErrors: number;
  malformedToolCalls: number;
  loopDetected: boolean;
  /** Remaining turns to stay remote after an escalation. */
  stickyRemoteTurns: number;
  /** The last turn's local attempt ended in refusal, max_tokens, or a provider error. */
  localTurnFailed: boolean;
}

export class SignalTracker {
  private consecutiveToolErrors = 0;
  private malformedToolCalls = 0;
  private recentCalls: string[] = [];
  private loopDetected = false;
  private stickyRemoteTurns = 0;
  private localTurnFailed = false;

  constructor(private readonly config: EscalationConfig) {}

  recordToolResult(ok: boolean): void {
    this.consecutiveToolErrors = ok ? 0 : this.consecutiveToolErrors + 1;
  }

  recordMalformedToolCall(): void {
    this.malformedToolCalls++;
  }

  recordToolCall(name: string, input: unknown): void {
    const key = `${name}:${stableStringify(input)}`;
    this.recentCalls.push(key);
    if (this.recentCalls.length > 20) this.recentCalls.shift();
    const repeats = this.recentCalls.filter((k) => k === key).length;
    if (repeats >= this.config.loopThreshold) this.loopDetected = true;
  }

  recordLocalFailure(): void {
    this.localTurnFailed = true;
  }

  /** Call once per completed model turn. */
  recordTurn(tier: Tier, escalated: boolean): void {
    if (escalated) {
      this.stickyRemoteTurns = this.config.stickyTurns;
      this.reset();
    } else if (tier === 'remote' && this.stickyRemoteTurns > 0) {
      this.stickyRemoteTurns--;
    }
  }

  /** A new user prompt starts a fresh task: clear quality signals but keep stickiness. */
  startUserTurn(): void {
    this.malformedToolCalls = 0;
    this.loopDetected = false;
    this.recentCalls = [];
  }

  snapshot(): SignalSnapshot {
    return {
      consecutiveToolErrors: this.consecutiveToolErrors,
      malformedToolCalls: this.malformedToolCalls,
      loopDetected: this.loopDetected,
      stickyRemoteTurns: this.stickyRemoteTurns,
      localTurnFailed: this.localTurnFailed,
    };
  }

  private reset(): void {
    this.consecutiveToolErrors = 0;
    this.malformedToolCalls = 0;
    this.loopDetected = false;
    this.recentCalls = [];
    this.localTurnFailed = false;
  }
}
