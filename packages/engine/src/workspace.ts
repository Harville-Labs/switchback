/** An engine for a workspace on disk: its agents, commands, skills, instructions, and stores. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgents } from './agents.ts';
import { FileCheckpointStore } from './checkpoints.ts';
import type { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import type { EngineOptions } from './engine-options.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import { FileSessionStore } from './store.ts';

export function engineFromWorkspace(
  workspaceRoot: string,
  config: SwitchbackConfig,
  extra: Partial<EngineOptions> = {},
): { engine: Engine; agentErrors: string[] } {
  const hp = switchbackPaths();
  const pp = projectPaths(workspaceRoot);
  const agentDirs: EngineOptions['agentDirs'] = [
    { dir: hp.agentsDir, source: 'user' },
    { dir: pp.agentsDir, source: 'project' },
  ];
  const { agents, errors } = loadAgents(agentDirs);
  const library: EngineOptions['library'] = {
    commands: [
      { dir: hp.commandsDir, source: 'user' },
      { dir: pp.commandsDir, source: 'project' },
    ],
    skills: [
      { dir: hp.skillsDir, source: 'user' },
      { dir: pp.skillsDir, source: 'project' },
    ],
  };
  const instructions = existsSync(pp.instructionsFile)
    ? readFileSync(pp.instructionsFile, 'utf8')
    : undefined;
  const engine = new Engine({
    workspaceRoot,
    config,
    agents,
    agentDirs,
    library,
    ...(instructions ? { instructions } : {}),
    ledgerFile: hp.usageFile,
    store: new FileSessionStore(hp.sessionsDir),
    checkpoints: new FileCheckpointStore(join(hp.dataDir, 'checkpoints')),
    ...extra,
  });
  return { engine, agentErrors: errors };
}
