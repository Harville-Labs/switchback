/**
 * Setup in VS Code: each question the engine asks (`setup.ask`) as a quick
 * pick or input box. The flow, its wording, and what gets written are the
 * engine's, the same as `switchback init`; this only draws questions and
 * returns answers. Dismissing a question (Escape) cancels setup.
 */
import { formatSetupNote, type SwitchbackClient } from '@switchback/client';
import type {
  EngineEvent,
  SetupAnswerParams,
  SetupOutcome,
  SetupQuestion,
} from '@switchback/protocol';
import * as vscode from 'vscode';

type Answer = SetupAnswerParams['value'];

const TITLE = 'Switchback setup';

interface Item extends vscode.QuickPickItem {
  index: number;
}

const itemsOf = (q: Extract<SetupQuestion, { options: unknown }>): Item[] =>
  q.options.map((o, index) => ({
    label: o.label,
    ...(o.hint ? { description: o.hint } : {}),
    ...(o.checked ? { picked: true } : {}),
    index,
  }));

/** A quick pick that resolves with what was accepted, or undefined when dismissed. */
function pick(
  question: string,
  items: Item[],
  options: { many?: boolean; active?: number; freeText?: boolean } = {},
): Promise<Item[] | string | undefined> {
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = TITLE;
  qp.placeholder = question;
  qp.ignoreFocusOut = true;
  qp.canSelectMany = options.many === true;
  qp.items = items;
  if (options.many) qp.selectedItems = items.filter((i) => i.picked);
  const start = options.active !== undefined ? items[options.active] : undefined;
  if (start) qp.activeItems = [start];
  // With free text, what's typed can be the answer when nothing listed matches.
  const typed = (value: string): Item => ({ label: `Use "${value}"`, index: -1 });
  if (options.freeText)
    qp.onDidChangeValue((value) => {
      const listed = items.some((i) => i.label === value);
      qp.items = value && !listed ? [...items, typed(value)] : items;
    });
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      const chosen = options.many ? [...qp.selectedItems] : [...qp.activeItems];
      const first = chosen[0];
      resolve(first && first.index === -1 ? qp.value : chosen);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/** Ask one question; null when the person dismissed it, which cancels setup. */
export async function askSetupQuestion(q: SetupQuestion): Promise<Answer> {
  switch (q.kind) {
    case 'confirm': {
      const yes: Item = { label: 'Yes', index: 1 };
      const no: Item = { label: 'No', index: 0 };
      const got = await pick(q.question, q.default ? [yes, no] : [no, yes]);
      return Array.isArray(got) && got[0] ? got[0].index === 1 : null;
    }
    case 'text': {
      const got = await vscode.window.showInputBox({
        title: TITLE,
        prompt: q.question,
        ...(q.default !== undefined ? { value: q.default } : {}),
        ignoreFocusOut: true,
      });
      return got ?? null;
    }
    case 'number': {
      const got = await vscode.window.showInputBox({
        title: TITLE,
        prompt: q.question,
        ...(q.default !== undefined ? { value: String(q.default) } : {}),
        ignoreFocusOut: true,
        validateInput: (v) => {
          const n = Number(v.trim().replaceAll(',', ''));
          return !v.trim() || (Number.isFinite(n) && n > 0)
            ? undefined
            : 'Enter a positive number, or leave it empty.';
        },
      });
      if (got === undefined) return null;
      return got.trim() ? Number(got.trim().replaceAll(',', '')) : '';
    }
    case 'select': {
      const got = await pick(q.question, itemsOf(q), { active: q.default });
      return Array.isArray(got) && got[0] ? got[0].index : null;
    }
    case 'multiSelect': {
      const got = await pick(q.question, itemsOf(q), { many: true });
      return Array.isArray(got) ? got.map((i) => i.index) : null;
    }
    case 'search': {
      const got = await pick(q.question, itemsOf(q), { freeText: q.freeText });
      if (typeof got === 'string') return got;
      return Array.isArray(got) && got[0] ? got[0].index : null;
    }
  }
}

/**
 * Run setup to the end: questions as quick picks, notes into the chat (`say`).
 * Resolves with how it ended; on `written`, restart the engine to use the new
 * config.
 */
export function runSetup(
  client: SwitchbackClient,
  say: (text: string) => void,
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
      if (e.type === 'setup.note') say(formatSetupNote(e.note));
      if (e.type === 'setup.ask')
        void askSetupQuestion(e.question)
          .then((value) => client.request('setup.answer', { requestId: e.requestId, value }))
          .catch(reject);
      if (e.type === 'setup.finished') {
        off();
        const { type: _, setupId: __, ...outcome } = e;
        resolve(outcome);
      }
    };
    const off = client.on(handle);
    client.request('setup.start', {}).then(
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
