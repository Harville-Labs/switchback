/** Interactive prompts for setup flows: arrow keys to choose, type to filter long lists. */
import { checkbox, confirm, input, search, select } from '@inquirer/prompts';
import { Fzf } from 'fzf';

const color = process.stdout.isTTY;
export const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
export const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
export const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
export const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

export interface Option<T> {
  label: string;
  value: T;
  hint?: string;
}

/** Ctrl+C ends setup the way it ends any command, not with a stack trace. */
async function asked<T>(prompt: Promise<T>): Promise<T> {
  try {
    return await prompt;
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') {
      process.stdout.write('\n');
      process.exit(130);
    }
    throw err;
  }
}

const choice = <T>(o: Option<T>) => ({
  name: o.hint ? `${o.label}  ${dim(o.hint)}` : o.label,
  short: o.label,
  value: o.value,
});

/**
 * A question's leading blank lines are printed rather than passed to the
 * prompt, which would otherwise draw its prefix on the empty line.
 */
function message(question: string): string {
  const text = question.replace(/^\n+/, '');
  if (text.length < question.length) process.stdout.write('\n');
  return text;
}

/** Where prompts read keys and draw; tests pass their own streams. */
export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

export class Prompter {
  private readonly context: Partial<PromptStreams>;

  constructor(streams?: PromptStreams) {
    this.context = streams ?? {};
  }

  /** Nothing to release; kept so callers can treat prompts as a resource. */
  close() {}

  async text(question: string, fallback?: string): Promise<string> {
    const answer = await asked(
      input(
        { message: message(question), ...(fallback ? { default: fallback } : {}) },
        this.context,
      ),
    );
    return answer.trim() || fallback || '';
  }

  async number(question: string, fallback?: number): Promise<number | undefined> {
    const raw = await asked(
      input(
        {
          message: message(question),
          ...(fallback !== undefined ? { default: fallback.toString() } : {}),
          validate: (v) =>
            !v.trim() || parse(v) !== undefined || 'Enter a positive number, or leave it empty.',
        },
        this.context,
      ),
    );
    return parse(raw) ?? (raw.trim() ? undefined : fallback);
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    return asked(confirm({ message: message(question), default: fallback }, this.context));
  }

  /** One of a few options, chosen with the arrow keys. */
  async select<T>(question: string, options: Option<T>[], defaultIndex = 0): Promise<T> {
    const fallback = options[defaultIndex]?.value;
    return asked(
      select(
        {
          message: message(question) || 'Choose one',
          choices: options.map(choice),
          pageSize: 12,
          ...(fallback !== undefined ? { default: fallback } : {}),
        },
        this.context,
      ),
    );
  }

  /** Any number of options: space toggles, enter accepts. */
  async multiSelect<T>(
    question: string,
    options: (Option<T> & { checked?: boolean })[],
  ): Promise<T[]> {
    return asked(
      checkbox(
        {
          message: message(question),
          choices: options.map((o) => ({ ...choice(o), checked: o.checked ?? false })),
          pageSize: 12,
        },
        this.context,
      ),
    );
  }

  /**
   * One of a long list (models an endpoint reported): type to filter, arrow to
   * choose. With `freeText`, what was typed can be kept even if it isn't listed.
   */
  async search(
    question: string,
    options: Option<string>[],
    opts: { freeText?: boolean } = {},
  ): Promise<string> {
    const fzf = new Fzf(options, { selector: (o) => o.label, limit: 200 });
    return asked(
      search(
        {
          message: message(question),
          pageSize: 12,
          source: (term) => {
            const typed = term?.trim() ?? '';
            const found = typed ? fzf.find(typed).map((r) => r.item) : options;
            const exact = found.some((o) => o.value === typed);
            return [
              ...found.map(choice),
              ...(opts.freeText && typed && !exact
                ? [{ name: `Use "${typed}"`, short: typed, value: typed }]
                : []),
            ];
          },
        },
        this.context,
      ),
    );
  }
}

function parse(raw: string): number | undefined {
  const n = Number(raw.trim().replaceAll(',', '').replaceAll('_', ''));
  return raw.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}
