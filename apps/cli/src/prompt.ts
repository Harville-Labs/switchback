/** Minimal line-based prompts for setup flows. Works in any terminal, no raw mode. */
import { createInterface, type Interface } from 'node:readline/promises';

const color = process.stdout.isTTY;
export const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
export const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
export const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
export const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);

export class Prompter {
  private rl: Interface;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  close() {
    this.rl.close();
  }

  async text(question: string, fallback?: string): Promise<string> {
    const suffix = fallback !== undefined && fallback !== '' ? dim(` (${fallback})`) : '';
    const answer = (await this.rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || '';
  }

  async number(question: string, fallback?: number): Promise<number | undefined> {
    for (;;) {
      const raw = await this.text(question, fallback?.toString());
      if (!raw) return undefined;
      const n = Number(raw.replaceAll(',', '').replaceAll('_', ''));
      if (Number.isFinite(n) && n > 0) return n;
      console.log(yellow('  Enter a positive number, or leave empty.'));
    }
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const answer = (await this.rl.question(`${question} ${dim(fallback ? '[Y/n]' : '[y/N]')} `))
      .trim()
      .toLowerCase();
    return answer ? answer.startsWith('y') : fallback;
  }

  /** Numbered choice. Returns the chosen value. */
  async select<T>(
    question: string,
    options: { label: string; value: T; hint?: string }[],
    defaultIndex = 0,
  ): Promise<T> {
    console.log(bold(question));
    options.forEach((o, i) => {
      console.log(
        `  ${i === defaultIndex ? green('›') : ' '} ${i + 1}. ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`,
      );
    });
    for (;;) {
      const raw = (
        await this.rl.question(`Choose 1-${options.length} ${dim(`(${defaultIndex + 1})`)}: `)
      ).trim();
      const i = raw ? Number(raw) - 1 : defaultIndex;
      const picked = options[i];
      if (picked) return picked.value;
      console.log(yellow(`  Enter a number from 1 to ${options.length}.`));
    }
  }
}
