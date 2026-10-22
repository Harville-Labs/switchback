import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

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

/** A path under the home directory as `~/...`, the way the docs write it; others as they are. */
export function tildify(path: string, home = homedir()): string {
  if (path === home) return '~';
  return path.startsWith(`${home}${sep}`) ? `~${sep}${path.slice(home.length + 1)}` : path;
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

/**
 * Where Switchback kept its files before 1.1.0 (`~/.config/switchback`,
 * `~/.local/share/switchback`), when they're still there. Nothing reads them;
 * `doctor` points them out so a stale copy isn't mistaken for the config.
 */
export function legacyDirs(env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME ?? homedir();
  return [
    join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'switchback'),
    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'switchback'),
    // Unless SWITCHBACK_HOME points there, which makes it the current home.
  ].filter((dir) => existsSync(dir) && dir !== switchbackHome(env));
}
