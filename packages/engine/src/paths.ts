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
    agentsDir: join(root, '.switchback', 'agents'),
    /** Claude Code compatibility: agents defined for Claude Code work unchanged. */
    claudeAgentsDir: join(root, '.claude', 'agents'),
    instructionFiles: [join(root, 'AGENTS.md'), join(root, 'CLAUDE.md')],
    /** Claude Code compatibility: project MCP servers. */
    mcpJson: join(root, '.mcp.json'),
  };
}
