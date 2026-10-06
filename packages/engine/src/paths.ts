import { homedir } from 'node:os';
import { join } from 'node:path';

/** XDG-style locations. `SWITCHBACK_HOME` relocates everything (used by tests). */
export function switchbackPaths(env: Record<string, string | undefined> = process.env) {
  const home = env.SWITCHBACK_HOME;
  const config = home ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'switchback');
  const data = home
    ? join(home, 'data')
    : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'switchback');
  return {
    configDir: config,
    configFile: join(config, 'config.json'),
    agentsDir: join(config, 'agents'),
    commandsDir: join(config, 'commands'),
    skillsDir: join(config, 'skills'),
    dataDir: data,
    sessionsDir: join(data, 'sessions'),
    usageFile: join(data, 'usage.jsonl'),
  };
}

export type SwitchbackPaths = ReturnType<typeof switchbackPaths>;

/** Project-level locations, relative to the workspace root. */
export function projectPaths(root: string) {
  return {
    configFile: join(root, '.switchback', 'config.json'),
    /** Personal settings for this project, never committed (rules saved from prompts). */
    localConfigFile: join(root, '.switchback', 'config.local.json'),
    agentsDir: join(root, '.switchback', 'agents'),
    commandsDir: join(root, '.switchback', 'commands'),
    skillsDir: join(root, '.switchback', 'skills'),
    /** Project instructions, in the open AGENTS.md convention (agents.md). */
    instructionsFile: join(root, 'AGENTS.md'),
  };
}
