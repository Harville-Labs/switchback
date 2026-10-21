/** Setup for every client that runs it (the TUI's `/init` and `switchback init`, VS Code). */
import type {
  EngineEvent,
  SetupAnswerParams,
  SetupNote,
  SetupOutcome,
  SetupQuestion,
  SetupStartParams,
} from '@switchback/protocol';
import type { SwitchbackClient } from './client.ts';
import { formatRoles } from './format.ts';

export function formatSetupNote(note: SetupNote): string {
  switch (note.kind) {
    case 'roles':
      return formatRoles(note.roles, note.models);
    case 'text':
      return note.tone === 'success'
        ? `✓ ${note.text}`
        : note.tone === 'warning'
          ? `! ${note.text}`
          : note.text;
  }
}

/** How a client shows setup: each question, answered (null cancels), and each note. */
export interface SetupUi {
  ask(question: SetupQuestion): Promise<SetupAnswerParams['value']>;
  note(note: SetupNote): void;
}

/**
 * Run the engine's setup to the end over the protocol, drawing it with `ui`.
 * Resolves with how it ended. The engine watches its config files, so a
 * `written` config is in use without a restart.
 */
export function runSetupOver(
  client: SwitchbackClient,
  ui: SetupUi,
  params: SetupStartParams = {},
): Promise<SetupOutcome> {
  return new Promise((resolve, reject) => {
    let setupId: string | undefined;
    // Events can arrive before setup.start returns the ID; hold them until then.
    const early: EngineEvent[] = [];
    const handle = (e: EngineEvent): void => {
      if (e.type !== 'setup.ask' && e.type !== 'setup.note' && e.type !== 'setup.finished') return;
      if (!setupId) {
        early.push(e);
        return;
      }
      if (e.setupId !== setupId) return;
      if (e.type === 'setup.note') ui.note(e.note);
      if (e.type === 'setup.ask')
        void ui
          .ask(e.question)
          .then((value) => client.request('setup.answer', { requestId: e.requestId, value }))
          .catch(reject);
      if (e.type === 'setup.finished') {
        off();
        const { type: _, setupId: __, ...outcome } = e;
        resolve(outcome);
      }
    };
    const off = client.on(handle);
    client.request('setup.start', params).then(
      (r) => {
        setupId = r.setupId;
        for (const e of early.splice(0)) handle(e);
      },
      (err) => {
        off();
        reject(err);
      },
    );
  });
}
