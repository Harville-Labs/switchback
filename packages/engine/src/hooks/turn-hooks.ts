/**
 * The hooks around a turn: SessionStart (once per session, before its first
 * prompt here), UserPromptSubmit (each prompt), and Stop / SubagentStop (when
 * the model is done, which a hook can refuse so the model keeps going).
 */
import type { LiveSession } from '../live-session.ts';
import type { HookRunner } from './runner.ts';

/** How many times Stop hooks may send the model back to work in one turn. */
export const MAX_STOP_CONTINUATIONS = 3;

export class TurnHooks {
  constructor(
    private readonly hooks: HookRunner,
    private readonly payload: (s: LiveSession) => Record<string, unknown>,
  ) {}

  /** Before a prompt is added: whether a hook blocks it, and context for the model. */
  async beforePrompt(
    s: LiveSession,
    prompt: string,
  ): Promise<{ blocked?: string; context: string[] }> {
    const context: string[] = [];
    if (s.depth > 0) return { context };
    if (!s.hooksStarted) {
      s.hooksStarted = true;
      if (this.hooks.has('SessionStart')) {
        // Loaded from the store with history: a resumed session.
        const source = s.messages.length ? 'resume' : 'startup';
        const start = await this.hooks.run('SessionStart', { ...this.payload(s), source }, source);
        context.push(...start.context);
      }
    }
    if (!this.hooks.has('UserPromptSubmit')) return { context };
    const r = await this.hooks.run('UserPromptSubmit', { ...this.payload(s), prompt });
    context.push(...r.context);
    return r.block ? { blocked: r.block, context } : { context };
  }

  /** When the model finished: the reason a Stop hook wants it to keep going, if any. */
  async keepGoing(s: LiveSession, continuations: number): Promise<string | undefined> {
    const event = s.depth > 0 ? 'SubagentStop' : 'Stop';
    if (continuations >= MAX_STOP_CONTINUATIONS || !this.hooks.has(event)) return undefined;
    const r = await this.hooks.run(event, {
      ...this.payload(s),
      // Claude Code's flag: true once a Stop hook has already sent the model back.
      stop_hook_active: continuations > 0,
    });
    return r.block;
  }
}
