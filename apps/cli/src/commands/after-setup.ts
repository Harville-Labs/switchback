/**
 * What setup asks after the models, for this machine and this person rather
 * than the engine: the Windows command sandbox and the telemetry choice. Both
 * `switchback init`'s prompts and the TUI's `/init` ask them through this.
 */
import { existsSync, readFileSync } from 'node:fs';
import { installSandbox, parseJsonc, sandboxInstalled, switchbackPaths } from '@switchback/engine';
import type { SetupNote } from '@switchback/protocol';
import { setTelemetry, TELEMETRY_PROMPT } from './telemetry.ts';

export interface AfterSetupUi {
  /** Undefined when the person skipped the question. */
  confirm(question: string, fallback: boolean): Promise<boolean | undefined>;
  note(note: SetupNote): void;
}

const note = (text: string, tone?: 'detail' | 'success'): SetupNote => ({
  kind: 'text',
  text,
  ...(tone ? { tone } : {}),
});

/** `telemetry` given (a flag) is applied without asking. */
export async function afterSetup(ui: AfterSetupUi, telemetry?: boolean): Promise<void> {
  await offerWindowsSandbox(ui);
  let share = telemetry;
  if (share === undefined && !telemetryChosen())
    share = await ui.confirm(
      `${TELEMETRY_PROMPT} Details: docs/telemetry.md; change it any time with \`switchback telemetry on|off\`.`,
      false,
    );
  if (share === undefined) return;
  setTelemetry(share);
  ui.note(note(`Telemetry ${share ? 'on. Thank you' : 'off'}.`, 'success'));
}

/** Windows sandboxes commands only after a one-time elevated install, which only this machine can do. */
async function offerWindowsSandbox(ui: AfterSetupUi) {
  if (process.platform !== 'win32') return;
  if (await sandboxInstalled(switchbackPaths().dataDir)) return;
  const install = await ui.confirm(
    'Set up the command sandbox? Commands then run as a separate account that can only write the workspace. Windows asks for administrator approval once.',
    true,
  );
  if (install === undefined) return;
  if (!install) {
    ui.note(
      note('Commands run unsandboxed. `switchback sandbox install` sets it up later.', 'detail'),
    );
    return;
  }
  const result = await installSandbox(switchbackPaths().dataDir);
  ui.note(note(result.message, result.ok ? 'success' : undefined));
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
