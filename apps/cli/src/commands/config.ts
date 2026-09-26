/** `harness config <path|show|schema|edit>`: inspect and edit configuration. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  configJsonSchema,
  harnessPaths,
  loadConfig,
  projectPaths,
  redactConfig,
} from '@harness/engine';
import { dim, green } from '../prompt.ts';

export async function config(
  action: string | undefined,
  flags: { cwd: string; scope?: 'user' | 'project' },
): Promise<number> {
  const hp = harnessPaths();
  const pp = projectPaths(flags.cwd);
  const mark = (f: string) => (existsSync(f) ? green('exists') : dim('not created'));
  switch (action) {
    case undefined:
    case 'path':
      console.log(`user config     ${hp.configFile}  ${mark(hp.configFile)}`);
      console.log(`project config  ${pp.configFile}  ${mark(pp.configFile)}`);
      console.log(`user agents     ${hp.agentsDir}`);
      console.log(`project agents  ${pp.agentsDir}, ${pp.claudeAgentsDir}`);
      console.log(`data            ${hp.dataDir}`);
      return 0;
    case 'show': {
      const { config: effective, sources } = loadConfig(flags.cwd);
      console.error(
        dim(`# merged from: built-in defaults${sources.map((s) => `, ${s}`).join('')}`),
      );
      console.log(JSON.stringify(redactConfig(effective), null, 2));
      return 0;
    }
    case 'schema':
      console.log(JSON.stringify(configJsonSchema(), null, 2));
      return 0;
    case 'edit': {
      const file = flags.scope === 'project' ? pp.configFile : hp.configFile;
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '{\n}\n');
      }
      const editor = process.env.VISUAL ?? process.env.EDITOR;
      if (!editor) {
        console.log(`${file}\n${dim('Set $EDITOR to open it automatically.')}`);
        return 0;
      }
      const proc = Bun.spawn(['sh', '-c', `${editor} "$1"`, 'sh', file], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      return proc.exited;
    }
    default:
      console.error(`harness config: unknown action "${action}" (path, show, schema, edit)`);
      return 2;
  }
}
