/** The engine binary the extension runs, from the user's settings or what's installed. */
import * as vscode from 'vscode';
import { chooseEngine, type EngineBinary, findCli, probeVersion } from './engine-binary.ts';
import { VERSION } from './version.ts';

// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code variable syntax, not a JS template.
const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** No engine to run: nothing bundled for this platform and no CLI installed. */
export class NoEngineError extends Error {}

/**
 * The engine to run: the user's setting if set, else the newer of the CLI and
 * the bundled binary (see engine-binary.ts). `${workspaceFolder}` is expanded.
 */
export async function resolveEngine(
  root: string,
  bundled: string | undefined,
): Promise<EngineBinary> {
  const cfg = vscode.workspace.getConfiguration('switchback');
  // VS Code does not expand variables in extension settings; support the common one.
  const expand = (v: string) => v.replaceAll(WORKSPACE_FOLDER_VAR, root);
  const args = cfg.get<string[]>('executableArgs', []).map(expand);
  const configured = cfg.get<string>('executablePath', '').trim();
  if (configured) {
    const command = expand(configured);
    return { command, args, version: await probeVersion(command, args), source: 'setting' };
  }
  const cli = await findCli();
  const chosen = chooseEngine({
    cli,
    bundled: bundled
      ? { command: bundled, args: [], version: VERSION, source: 'bundled' }
      : undefined,
  });
  if (!chosen)
    throw new NoEngineError(
      'no switchback engine found: this platform has no bundled engine and the switchback CLI is not installed',
    );
  return { ...chosen, args: [...chosen.args, ...args] };
}
