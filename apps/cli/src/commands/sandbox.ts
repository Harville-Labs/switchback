/**
 * `switchback sandbox [install|uninstall]`: the one-time setup Windows needs
 * before bash commands can run sandboxed. macOS and Linux need none.
 */
import { installSandbox, switchbackPaths, uninstallSandbox } from '@switchback/engine';
import { green, yellow } from '../prompt.ts';

export async function sandbox(sub: string | undefined): Promise<number> {
  const { dataDir } = switchbackPaths();
  const run = { install: installSandbox, uninstall: uninstallSandbox }[sub ?? 'install'];
  if (!run) {
    console.error('switchback sandbox: expected install or uninstall');
    return 2;
  }
  if (process.platform === 'win32' && sub !== 'uninstall')
    console.log('Windows will ask for administrator approval once.');
  const result = await run(dataDir);
  console.log(result.ok ? `${green('✓')} ${result.message}` : yellow(result.message));
  return result.ok ? 0 : 1;
}
