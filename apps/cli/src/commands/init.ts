/**
 * `switchback init`: guided configuration in the terminal. The questions are
 * the engine's (setup-flow), the same ones VS Code asks; this draws them, then
 * offers what only a terminal on this machine can: the Windows command
 * sandbox, the telemetry choice, and a `doctor` check. Every question has a
 * flag so setup can also run unattended (`--yes`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { formatSetupNote } from '@switchback/client';
import {
  installSandbox,
  parseJsonc,
  runSetup,
  SetupError,
  type SetupFlags,
  type SetupPrompter,
  sandboxInstalled,
  switchbackPaths,
  unattended,
} from '@switchback/engine';
import type { SetupNote } from '@switchback/protocol';
import { bold, dim, green, Prompter, yellow } from '../prompt.ts';
import { doctor } from './doctor.ts';
import { setTelemetry, TELEMETRY_PROMPT } from './telemetry.ts';

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
  if (note.kind === 'config') {
    const [head, ...json] = formatSetupNote(note).split('\n');
    return `\n${bold(head ?? '')}\n${json.join('\n')}\n`;
  }
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
    text: (q, fallback) => p.text(q, fallback),
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
  await offerWindowsSandbox(p);
  const share =
    flags.telemetry ??
    (p && !telemetryChosen()
      ? await p.confirm(
          `\n${TELEMETRY_PROMPT}\n${dim('  Details: docs/telemetry.md. Change it any time with `switchback telemetry on|off`.')}\n `,
          false,
        )
      : undefined);
  if (share !== undefined) {
    setTelemetry(share);
    console.log(`${green('✓')} Telemetry ${share ? 'on. Thank you' : 'off'}.\n`);
  }
  await doctor({ cwd: flags.cwd, mock: false });
  return 0;
}

/** Windows sandboxes commands only after a one-time elevated install, which only a terminal here can do. */
async function offerWindowsSandbox(p: Prompter | undefined) {
  if (process.platform !== 'win32' || !p) return;
  if (await sandboxInstalled(switchbackPaths().dataDir)) return;
  const install = await p.confirm(
    `\nSet up the command sandbox? ${dim('Commands then run as a separate account that can only write the workspace. Windows asks for administrator approval once.')}`,
  );
  if (!install) {
    console.log(
      dim('  Commands run unsandboxed. `switchback sandbox install` sets it up later.\n'),
    );
    return;
  }
  const result = await installSandbox(switchbackPaths().dataDir);
  console.log(result.ok ? `${green('✓')} ${result.message}\n` : `  ${result.message}\n`);
}

/** Whether the user has answered before (either way): their config says. */
function telemetryChosen(): boolean {
  const file = switchbackPaths().configFile;
  if (!existsSync(file)) return false;
  try {
    const cfg = parseJsonc(readFileSync(file, 'utf8')) as { telemetry?: { enabled?: unknown } };
    return typeof cfg.telemetry?.enabled === 'boolean';
  } catch {
    return false;
  }
}

/** First run, before the TUI opens: straight into setup, which can be answered "no" throughout. */
export async function offerSetup(cwd: string): Promise<number> {
  console.log(`${bold('No Switchback configuration found.')} Let's add your models.\n`);
  return init({
    cwd,
    yes: false,
    noLocal: false,
    localUrls: [],
    localModels: [],
    contextWindows: [],
    remotes: [],
    remoteModels: [],
  });
}
