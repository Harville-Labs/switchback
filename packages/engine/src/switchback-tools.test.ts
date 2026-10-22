import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, ToolResultPart } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { loadConfig } from './config.ts';
import { Engine, type EngineOptions } from './engine.ts';
import { forContext, toolsFor } from './tools/index.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-settings-tools-'));
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'ws'));
  file = join(dir, 'home', 'config.json');
  writeFileSync(
    file,
    `{
  // mine
  "providers": {
    "lp": { "type": "mock", "tier": "local" },
    "rp": {
      "type": "openai-compatible",
      "tier": "remote",
      "baseUrl": "http://localhost:9",
      "apiKey": "sk-secret",
      "headers": { "X-Team": "team-token" }
    }
  },
  "models": {
    "local": { "provider": "lp", "model": "small", "contextWindow": 32000 },
    "remote": { "provider": "rp", "model": "big", "contextWindow": 200000, "price": { "input": 3, "output": 15 } }
  },
  "routing": { "current": ["local"], "escalate": [["remote"]] }
}
`,
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(script: Script, opts: Partial<EngineOptions> = {}) {
  const ws = join(dir, 'ws');
  const load = () => loadConfig(ws, { SWITCHBACK_HOME: join(dir, 'home') }, [], null);
  const { config, rules } = load();
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({
    workspaceRoot: ws,
    config,
    rules,
    providers: new Map([['lp', lp]]),
    userConfigFile: file,
    reloadConfig: load,
    ...opts,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, events };
}

/** The tool results the model saw on its second call. */
const results = (lp: ScriptedProvider) =>
  (lp.requests[1]?.messages.at(-1)?.parts ?? []) as ToolResultPart[];
const session = (engine: Engine) => engine.createSession({}).id;

describe('reading settings', () => {
  test('models lists each model with its tier, price, and role in the session', async () => {
    const { engine, lp } = setup([{ toolCalls: [{ name: 'models', input: {} }] }, { text: 'ok' }]);
    await engine.runTurn(session(engine), 'which models can a subagent use?');
    const out = String(results(lp)[0]?.content);
    expect(out).toContain('- local: small on lp · local · 32k context · free · role: current');
    expect(out).toContain('- remote: big on rp · remote · 200k context · $3/$15 per M tokens');
    expect(out).toContain('role: ladder');
    expect(out).toContain('escalation ladder (hard turns climb it): remote');
  });

  test('config shows a section with secrets and header values hidden', async () => {
    const read = { name: 'config', input: { key: 'providers.rp' } };
    const { engine, lp } = setup([{ toolCalls: [read] }, { text: 'ok' }]);
    await engine.runTurn(session(engine), 'how is rp set up?');
    const out = String(results(lp)[0]?.content);
    expect(out).toContain('"baseUrl": "http://localhost:9"');
    expect(out).toContain('"X-Team": "<redacted>"');
    expect(out).not.toContain('sk-secret');
    expect(out).not.toContain('team-token');
  });

  test('every session can read settings, but only a top-level one changes its roles', () => {
    const names = (allowed: string[] | undefined, top: boolean) =>
      toolsFor(allowed, top).map((t) => t.name);
    expect(names(['read'], false)).toEqual(expect.arrayContaining(['read', 'models', 'config']));
    expect(names(['read'], false)).not.toContain('set_config');
    expect(names(['edit'], false)).toContain('set_config');
    expect(names(['edit'], false)).not.toContain('set_roles');
    expect(names(undefined, true)).toContain('set_roles');
  });
});

describe('small models', () => {
  const shrink = () =>
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('"contextWindow": 32000', '"contextWindow": 8000'),
    );

  test('a model under 32k of context gets the core tools only, in the same order', () => {
    const names = (window: number) =>
      forContext(toolsFor(undefined, true), window).map((t) => t.name);
    expect(names(200_000)).toContain('set_roles');
    expect(names(8_000)).toEqual([
      'read',
      'glob',
      'grep',
      'edit',
      'write',
      'bash',
      'task',
      'exit_plan_mode',
      'bash_output',
      'kill_shell',
      'webfetch',
      'websearch',
      'todo',
      'skill',
      'docs',
      'escalate',
      'goal',
    ]);
  });

  test('the request to a small model carries the small list', async () => {
    shrink();
    const { engine, lp } = setup([{ text: 'ok' }]);
    await engine.runTurn(session(engine), 'hi');
    const sent = lp.requests[0]?.tools.map((t) => t.name) ?? [];
    expect(sent).toContain('read');
    expect(sent).not.toContain('models');
    expect(sent).toContain('websearch');
    expect(sent).not.toContain('set_config');
  });

  test('a call to a tool the small model was not offered fails', async () => {
    shrink();
    const { engine, lp } = setup([{ toolCalls: [{ name: 'models', input: {} }] }, { text: 'ok' }]);
    await engine.runTurn(session(engine), 'list models');
    expect(String(results(lp)[0]?.content)).toContain('unknown tool "models"');
  });
});

describe('changing settings', () => {
  test('set_config keeps the file comments and applies the change at once', async () => {
    const set = {
      name: 'set_config',
      input: { key: 'compaction.enabled', value: 'false', file: 'user' },
    };
    const { engine, lp } = setup([{ toolCalls: [set] }, { text: 'ok' }], {
      interaction: 'approve',
    });
    await engine.runTurn(session(engine), 'turn off compaction');
    expect(String(results(lp)[0]?.content)).toContain('Changed in effect: compaction');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('// mine');
    expect(text).toContain('"enabled": false');
  });

  test('set_config asks even when edits are allowed', async () => {
    const set = {
      name: 'set_config',
      input: { key: 'compaction.enabled', value: 'false', file: 'user' },
    };
    const { engine, lp } = setup([{ toolCalls: [set] }, { text: 'ok' }], {
      interaction: 'deny',
      rules: [{ rule: 'edit', behavior: 'allow', source: 'config' }],
    });
    const before = readFileSync(file, 'utf8');
    await engine.runTurn(session(engine), 'turn off compaction');
    expect(results(lp)[0]?.isError).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('set_config refuses a value the config schema rejects, leaving the file alone', async () => {
    const set = { name: 'set_config', input: { key: 'routing.current', value: '5', file: 'user' } };
    const { engine, lp } = setup([{ toolCalls: [set] }, { text: 'ok' }], {
      interaction: 'approve',
    });
    const before = readFileSync(file, 'utf8');
    await engine.runTurn(session(engine), 'break it');
    expect(String(results(lp)[0]?.content)).toContain('invalid');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('set_roles changes the ladder for the session and tells the clients', async () => {
    const set = { name: 'set_roles', input: { escalate: [] } };
    const { engine, lp, events } = setup([{ toolCalls: [set] }, { text: 'ok' }], {
      interaction: 'approve',
    });
    const id = session(engine);
    await engine.runTurn(id, 'never escalate this session');
    expect(String(results(lp)[0]?.content)).toContain(
      'escalation ladder (hard turns climb it): empty',
    );
    expect(engine.roles(id).escalate).toEqual([]);
    expect(events.some((e) => e.type === 'roles.updated')).toBe(true);
  });
});
