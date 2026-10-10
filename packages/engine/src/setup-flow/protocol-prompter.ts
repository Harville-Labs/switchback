/**
 * Setup run for a client over the protocol: each question is a `setup.ask`
 * event, answered with `setup.answer`; notes are `setup.note` events. The
 * client only draws questions and sends answers back, so the flow itself
 * stays in one place (flow.ts).
 */
import type {
  EngineEvent,
  SetupAnswerParams,
  SetupOutcome,
  SetupQuestion,
  SetupStartParams,
} from '@switchback/protocol';
import { PendingPrompts } from '../prompts.ts';
import { SetupError } from './flags.ts';
import { runSetup, type SetupDeps } from './flow.ts';
import type { SetupChoice, SetupPrompter } from './prompter.ts';

type Answer = SetupAnswerParams['value'];

/** Thrown inside the flow when the person cancels; ends setup without writing anything. */
class Cancelled extends Error {}

function protocolPrompter(
  setupId: string,
  emit: (event: EngineEvent) => void,
  prompts: PendingPrompts<Answer>,
  signal: AbortSignal,
): SetupPrompter {
  const ask = async (question: SetupQuestion): Promise<Exclude<Answer, null>> => {
    const requestId = `setup_${crypto.randomUUID().slice(0, 8)}`;
    const answer = await prompts.ask(requestId, signal, null, () =>
      emit({ type: 'setup.ask', setupId, requestId, question }),
    );
    if (answer === null) throw new Cancelled();
    return answer;
  };
  const wrong = (kind: string) =>
    new SetupError(`the client answered a ${kind} question with the wrong kind of value`);
  const options = <T>(choices: SetupChoice<T>[]) =>
    choices.map(({ label, hint, checked }) => ({
      label,
      ...(hint ? { hint } : {}),
      ...(checked ? { checked } : {}),
    }));
  const pick = <T>(choices: SetupChoice<T>[], i: unknown): T => {
    const choice = typeof i === 'number' ? choices[i] : undefined;
    if (!choice) throw wrong('choice');
    return choice.value;
  };
  return {
    async text(question, fallback) {
      const a = await ask({
        kind: 'text',
        question,
        ...(fallback !== undefined ? { default: fallback } : {}),
      });
      if (typeof a !== 'string') throw wrong('text');
      return a.trim() || fallback || '';
    },
    async number(question, fallback) {
      const a = await ask({
        kind: 'number',
        question,
        ...(fallback !== undefined ? { default: fallback } : {}),
      });
      // An empty answer takes the default, as in the terminal.
      if (a === '') return fallback;
      if (typeof a !== 'number' || !(a > 0)) throw wrong('number');
      return a;
    },
    async confirm(question, fallback = true) {
      const a = await ask({ kind: 'confirm', question, default: fallback });
      if (typeof a !== 'boolean') throw wrong('yes/no');
      return a;
    },
    async select(question, choices, defaultIndex = 0) {
      return pick(
        choices,
        await ask({ kind: 'select', question, options: options(choices), default: defaultIndex }),
      );
    },
    async multiSelect(question, choices) {
      const a = await ask({ kind: 'multiSelect', question, options: options(choices) });
      if (!Array.isArray(a)) throw wrong('multi-select');
      return a.map((i) => pick(choices, i));
    },
    async search(question, choices, opts = {}) {
      const a = await ask({
        kind: 'search',
        question,
        options: options(choices),
        freeText: opts.freeText === true,
      });
      if (typeof a === 'number') return pick(choices, a);
      if (typeof a === 'string' && opts.freeText && a.trim()) return a.trim();
      throw wrong('search');
    },
    note(note) {
      emit({ type: 'setup.note', setupId, note });
    },
  };
}

/** Setups clients are running, one per `setup.start`. */
export class SetupRuns {
  readonly prompts = new PendingPrompts<Answer>('setup question');
  private running = new Map<string, AbortController>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly emit: (event: EngineEvent) => void,
    private readonly deps: SetupDeps = {},
    /** A config was written: apply it before telling the client. */
    private readonly onWritten: () => void = () => {},
  ) {}

  start(params: SetupStartParams): { setupId: string } {
    const setupId = `setup_${crypto.randomUUID().slice(0, 12)}`;
    const abort = new AbortController();
    this.running.set(setupId, abort);
    const ui = protocolPrompter(setupId, this.emit, this.prompts, abort.signal);
    const flags = {
      cwd: this.workspaceRoot,
      yes: false,
      noLocal: false,
      localUrls: [],
      localModels: [],
      contextWindows: [],
      remotes: [],
      remoteModels: [],
      ...(params.scope ? { scope: params.scope } : {}),
    };
    const finish = (outcome: SetupOutcome) => {
      this.running.delete(setupId);
      this.emit({ type: 'setup.finished', setupId, ...outcome });
    };
    // Answered through events after this returns; the client hears the end as `setup.finished`.
    void runSetup(flags, ui, this.deps).then(
      (r) => {
        if (r.outcome !== 'written') return finish({ outcome: 'nothing' });
        this.onWritten();
        finish({ outcome: 'written', file: r.file });
      },
      (err: Error) =>
        finish(
          err instanceof Cancelled || abort.signal.aborted
            ? { outcome: 'cancelled' }
            : { outcome: 'failed', message: err.message },
        ),
    );
    return { setupId };
  }

  answer(params: SetupAnswerParams): void {
    this.prompts.answer(params.requestId, params.value);
  }

  cancel(setupId: string): void {
    this.running.get(setupId)?.abort();
  }
}
