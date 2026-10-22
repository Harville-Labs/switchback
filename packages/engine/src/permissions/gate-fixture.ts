/** Shared setup for the gate's engine-level tests. */
import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, PermissionLevel, ToolResultPart } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from '../config.ts';
import { Engine, type EngineOptions } from '../engine.ts';

export let root: string;

/** Gives each test a fresh workspace. Call it at the top of every test file that uses this one. */
export function useWorkspace() {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'switchback-perm-'));
    writeFileSync(join(root, 'a.txt'), 'alpha\n');
    writeFileSync(join(root, '.env'), 'TOKEN=alpha\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
}

export function setup(
  script: Script,
  permissions: object = {},
  opts: Partial<Omit<EngineOptions, 'config'>> = {},
  extra: object = {},
) {
  const config = SwitchbackConfig.parse({
    providers: { lp: { type: 'mock', tier: 'local' } },
    models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
    routing: { current: ['local'] },
    permissions,
    ...extra,
  });
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({
    workspaceRoot: root,
    config,
    providers: new Map([['lp', lp]]),
    userConfigFile: join(root, 'user-config.json'),
    ...opts,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, events };
}

/** The tool results the model saw on its second call. */
export function results(lp: ScriptedProvider, call = 1): ToolResultPart[] {
  return (lp.requests[call]?.messages.at(-1)?.parts ?? []) as ToolResultPart[];
}

export const edit = { name: 'write', input: { path: 'b.txt', content: 'beta\n' } };
export const session = (engine: Engine, level?: PermissionLevel, agent?: string) =>
  engine.createSession({
    ...(level ? { permissionLevel: level } : {}),
    ...(agent ? { agent } : {}),
  }).id;
