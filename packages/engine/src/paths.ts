import { homedir } from 'node:os';
import { join } from 'node:path';

/** XDG-style locations. `HARNESS_HOME` relocates everything (used by tests). */
export function harnessPaths(env: Record<string, string | undefined> = process.env) {
  const home = env.HARNESS_HOME;
  const config = home ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'harness');
  const data = home
    ? join(home, 'data')
    : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'harness');
  return {
    configDir: config,
    configFile: join(config, 'config.json'),
    agentsDir: join(config, 'agents'),
    dataDir: data,
    sessionsDir: join(data, 'sessions'),
    usageFile: join(data, 'usage.jsonl'),
  };
}

export type HarnessPaths = ReturnType<typeof harnessPaths>;

/** Project-level locations, relative to the workspace root. */
export function projectPaths(root: string) {
  return {
    configFile: join(root, '.harness', 'config.json'),
    agentsDir: join(root, '.harness', 'agents'),
    /** Claude Code compatibility: agents defined for Claude Code work unchanged. */
    claudeAgentsDir: join(root, '.claude', 'agents'),
    instructionFiles: [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')],
  };
}
