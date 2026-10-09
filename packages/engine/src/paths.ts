import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Everything of Switchback's lives in `~/.switchback`, laid out like a
 * project's `.switchback/` with its state under `data/`, on every platform.
 * `SWITCHBACK_HOME` relocates it (tests, development).
 */
export function switchbackHome(env: Record<string, string | undefined> = process.env): string {
  return env.SWITCHBACK_HOME ?? join(homedir(), '.switchback');
}

export function switchbackPaths(env: Record<string, string | undefined> = process.env) {
  const config = switchbackHome(env);
  const data = join(config, 'data');
  return {
    configDir: config,
    configFile: join(config, 'config.json'),
    agentsDir: join(config, 'agents'),
    commandsDir: join(config, 'commands'),
    skillsDir: join(config, 'skills'),
    /** Your instructions for every project, in the same AGENTS.md format as a project's. */
    instructionsFile: join(config, 'AGENTS.md'),
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
