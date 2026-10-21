/**
 * `switchback init` with answers given as flags, or without a terminal: setup
 * as one prompt after another, for scripts and unattended installs (`--yes`).
 * Plain `switchback init` opens Switchback and runs setup there instead
 * (`/init`). The questions are the engine's (setup-flow) either way; this
 * draws them, then asks what `afterSetup` asks and runs a `doctor` check.
 */
import { formatSetupNote } from '@switchback/client';
import {
  runSetup,
  SetupError,
  type SetupFlags,
  type SetupPrompter,
  unattended,
} from '@switchback/engine';
import type { SetupNote } from '@switchback/protocol';
import { bold, dim, green, Prompter, yellow } from '../prompt.ts';
import { afterSetup } from './after-setup.ts';
import { doctor } from './doctor.ts';

export type { SetupFlags as InitFlags } from '@switchback/engine';

export async function init(flags: SetupFlags): Promise<number> {
  if (!flags.yes && !process.stdin.isTTY) {
    process.stderr.write(
      'switchback init: not a terminal; pass --yes with flags (see `switchback --help`)\n',
    );
    return 2;
  }
  const p = flags.yes ? undefined : new Prompter();
  try {
    return await run(flags, p);
  } catch (err) {
    if (err instanceof SetupError) {
      process.stderr.write(`switchback init: ${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    p?.close();
  }
}

/** Setup's notes, drawn for a terminal: the shared text, with color. */
export function drawNote(note: SetupNote): string {
  if (note.kind === 'roles')
    return formatSetupNote(note)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
  switch (note.tone) {
    case 'heading':
      return `\n${bold(note.text)}`;
    case 'detail':
      return dim(`  ${note.text}`);
    case 'warning':
      return yellow(`  ${note.text}`);
    case 'success':
      return `${green('✓')} ${note.text}`;
    default:
      return note.text;
  }
}

/** The terminal prompts, as setup asks for them; a blank line before each question keeps steps apart. */
function terminal(p: Prompter): SetupPrompter {
  return {
    text: (q, fallback, opts) => p.text(q, fallback, opts),
    number: (q, fallback) => p.number(q, fallback),
    confirm: (q, fallback) => p.confirm(`\n${q}`, fallback),
    select: (q, options, i) => p.select(`\n${q}`, options, i),
    multiSelect: (q, options) => p.multiSelect(`\n${q}`, options),
    search: (q, options, opts) => p.search(q, options, opts),
    note: (note) => console.log(drawNote(note)),
  };
}

async function run(flags: SetupFlags, p: Prompter | undefined): Promise<number> {
  if (p)
    console.log(
      `${bold('Switchback setup')}\n${dim('Add your local endpoints and hosted providers, then choose which model starts, which ones it escalates to, and who reviews.')}`,
    );
  const result = await runSetup(
    flags,
    p ? terminal(p) : unattended((note) => console.log(drawNote(note))),
  );
  if (result.outcome === 'nothing') {
    if (p) console.log(`\nNothing changed. Run ${bold('switchback init')} any time.\n`);
    return 0;
  }
  await afterSetup(
    {
      confirm: async (q, fallback) => (p ? p.confirm(`\n${q}\n `, fallback) : undefined),
      note: (note) => console.log(drawNote(note)),
    },
    flags.telemetry,
  );
  await doctor({ cwd: flags.cwd, mock: false });
  return 0;
}

/** Whether any flag answers a question; only then does `switchback init` prompt in the terminal. */
export function answersGiven(flags: SetupFlags): boolean {
  // `noLocal` is false unless given; every other answer is absent or empty unless given.
  const { cwd: _, yes: __, scope: ___, noLocal, ...answers } = flags;
  return (
    noLocal ||
    Object.values(answers).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0))
  );
}
