import * as vscode from 'vscode';
import type { SwitchbackTestApi } from '../../src/extension.ts';

export async function api(): Promise<SwitchbackTestApi> {
  const ext = vscode.extensions.getExtension<SwitchbackTestApi>('harville-labs.switchback');
  if (!ext) throw new Error('extension not found');
  const a = await ext.activate();
  await waitFor(() => a.connected(), 30_000, 'engine connection');
  return a;
}

export async function waitFor(check: () => boolean, timeoutMs = 20_000, what = 'condition') {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
