import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, Message } from '@harness/protocol';
import { type Script, ScriptedProvider } from '@harness/providers';
import { loadAgents } from './agents.ts';
import { HarnessConfig } from './config.ts';
import { Engine } from './engine.ts';
import {
  type PrivatePathMatcher,
  privatePathMatcher,
  privateReason,
  privateToolUse,
  redactOutbound,
  redactSecrets,
} from './privacy.ts';
import { MemorySessionStore } from './store.ts';

const TOKEN = 'ghp_1234567890abcdefghijABCDEFGHIJ123456';

describe('privatePathMatcher', () => {
  const m = privatePathMatcher([
    'secrets/',
    '*.pem',
    '.env*',
    'config/prod/**',
  ]) as PrivatePathMatcher;
  test('directories, file names anywhere, and nested globs', () => {
    expect(m('secrets/db.yml')).toBe(true);
    expect(m('secrets/deep/x.json')).toBe(true);
    expect(m('certs/server.pem')).toBe(true);
    expect(m('server.pem')).toBe(true);
    expect(m('.env')).toBe(true);
    expect(m('app/.env.local')).toBe(true);
    expect(m('config/prod/a.yml')).toBe(true);
    expect(m('config/dev/a.yml')).toBe(false);
    expect(m('src/secrets.ts')).toBe(false);
  });
  test('no patterns, no matcher', () => {
    expect(privatePathMatcher([])).toBeUndefined();
  });
});

describe('privateToolUse', () => {
  const m = privatePathMatcher(['secrets/']) as PrivatePathMatcher;
  const root = '/repo';
  test('file tools by path, grep by the files its output quotes, bash by named paths', () => {
    expect(privateToolUse(m, root, 'read', { path: 'secrets/a.env' }, '')).toBe(
      'read secrets/a.env',
    );
    expect(privateToolUse(m, root, 'read', { path: './secrets/../src/a.ts' }, '')).toBeUndefined();
    expect(privateToolUse(m, root, 'edit', { path: 'secrets/a.env' }, '')).toBe(
      'edit secrets/a.env',
    );
    expect(
      privateToolUse(m, root, 'grep', { pattern: 'x' }, 'src/a.ts:1: x\nsecrets/b.yml:4: x=1'),
    ).toBe('grep matched secrets/b.yml');
    expect(privateToolUse(m, root, 'grep', { pattern: 'x' }, 'src/a.ts:1: x')).toBeUndefined();
    expect(privateToolUse(m, root, 'bash', { command: 'cat "secrets/b.yml" | head' }, '')).toBe(
      'a command named secrets/b.yml',
    );
    expect(privateToolUse(m, root, 'bash', { command: 'FILE=secrets/x ./run' }, '')).toBe(
      'a command named secrets/x',
    );
    expect(privateToolUse(m, root, 'bash', { command: 'bun test' }, '')).toBeUndefined();
    expect(privateToolUse(m, root, 'glob', { pattern: 'secrets/**' }, 'secrets/a')).toBeUndefined();
  });
});

describe('secret redaction', () => {
  test('replaces secrets with a placeholder naming the kind', async () => {
    const r = await redactSecrets(`token = "${TOKEN}"`);
    expect(r.text).toBe('token = "[redacted GITHUB_TOKEN]"');
    expect(r.found).toEqual(['GITHUB_TOKEN']);
  });

  test('is deterministic and leaves the transcript untouched', async () => {
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: `use ${TOKEN}` }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: `gh ${TOKEN}` } }],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'c1', content: `ok ${TOKEN}` }] },
    ];
    const snapshot = structuredClone(messages);
    const a = await redactOutbound('system', messages);
    const b = await redactOutbound('system', messages);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
    expect(JSON.stringify(a.messages)).not.toContain(TOKEN);
    expect(a.found).toHaveLength(3);
    expect(messages).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-privacy-'));
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets', 'prod.env'), 'DB_PASSWORD=swordfish\n');
  writeFileSync(join(root, 'README.md'), 'hello\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(local: Script, remote: Script, config: object = {}) {
  const lp = new ScriptedProvider('lp', 'local', local);
  const rp = new ScriptedProvider('rp', 'remote', remote);
  const store = new MemorySessionStore();
  const make = () =>
    new Engine({
      workspaceRoot: root,
      config: HarnessConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
          remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        privacy: { localOnlyPaths: ['secrets/'] },
        ...config,
      }),
      providers: new Map([
        ['lp', lp],
        ['rp', rp],
      ]),
      store,
      agents: loadAgents([]).agents,
    });
  const engine = make();
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, lp, rp, events, make };
}

const sent = (p: ScriptedProvider) => JSON.stringify(p.requests);

describe('private paths', () => {
  test('reading a private file pins the session local, even for /remote', async () => {
    const { engine, lp, rp, events } = setup(
      [
        { toolCalls: [{ name: 'read', input: { path: 'secrets/prod.env' } }] },
        { text: 'read it' },
        { text: 'still local' },
      ],
      [{ text: 'remote!' }],
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'check the db password');
    const completed = events.find((e) => e.type === 'tool.completed');
    expect(completed).toMatchObject({ private: 'read secrets/prod.env' });

    const r = await engine.runTurn(s.id, 'now think hard', 'remote');
    expect(r.text).toBe('still local');
    expect(rp.requests).toHaveLength(0);
    expect(events.findLast((e) => e.type === 'route.decided')).toMatchObject({
      tier: 'local',
      rule: 'privacy',
    });
    expect(sent(lp)).toContain('swordfish');
  });

  test('the pin survives a restart: it is in the transcript', async () => {
    const { engine, rp, make } = setup(
      [{ toolCalls: [{ name: 'read', input: { path: 'secrets/prod.env' } }] }, { text: 'ok' }],
      [{ text: 'remote!' }],
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'look');
    const again = make();
    const messages = again.getSession(s.id).messages;
    expect(privateReason(messages)).toBe('read secrets/prod.env');
    await again.runTurn(s.id, 'more', 'remote');
    expect(rp.requests).toHaveLength(0);
  });

  test('@-mentioning a private file marks it; other files are fine', async () => {
    const { engine, rp } = setup([{ text: 'ok' }], [{ text: 'remote ok' }]);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'explain @README.md', 'remote');
    expect(r.text).toBe('remote ok');
    const s2 = engine.createSession({});
    const r2 = await engine.runTurn(s2.id, 'explain @secrets/prod.env', 'remote');
    expect(r2.text).toBe('ok');
    expect(sent(rp)).not.toContain('swordfish');
  });

  test('subagents inherit the pin, and a private subagent report pins the parent', async () => {
    const { engine, rp } = setup(
      (req) => {
        const last = JSON.stringify(req.messages.at(-1));
        const parent = req.tools.some((t) => t.name === 'task');
        if (last.includes('tool_result')) return { text: parent ? 'done' : 'found it' };
        if (!parent) return { toolCalls: [{ name: 'read', input: { path: 'secrets/prod.env' } }] };
        if (last.includes('explore it'))
          return {
            toolCalls: [
              { name: 'task', input: { agent: 'explore', description: 'look', prompt: 'go' } },
            ],
          };
        return { text: 'done' };
      },
      [{ text: 'remote' }],
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'explore it');
    const report = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report).toMatchObject({ private: 'subagent explore: read secrets/prod.env' });
    const r = await engine.runTurn(s.id, 'and now?', 'remote');
    expect(r.text).toBe('done');
    expect(rp.requests).toHaveLength(0);
  });
});

describe('secrets', () => {
  test('redacted from remote requests only; the transcript keeps them', async () => {
    const { engine, lp, rp, events } = setup([{ text: 'local sees it' }], [{ text: 'remote' }]);
    const s = engine.createSession({});
    await engine.runTurn(s.id, `why does ${TOKEN} fail?`);
    expect(sent(lp)).toContain(TOKEN);
    await engine.runTurn(s.id, 'ask the big model', 'remote');
    expect(sent(rp)).not.toContain(TOKEN);
    expect(sent(rp)).toContain('[redacted GITHUB_TOKEN]');
    expect(events.filter((e) => e.type === 'secrets.redacted')).toHaveLength(1);
    expect(JSON.stringify(engine.getSession(s.id).messages)).toContain(TOKEN);
  });

  test('block keeps the turn local', async () => {
    const { engine, rp, events } = setup([{ text: 'local' }], [{ text: 'remote' }], {
      privacy: { secrets: 'block' },
    });
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, `deploy with ${TOKEN}`, 'remote');
    expect(r.text).toBe('local');
    expect(rp.requests).toHaveLength(0);
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({ rule: 'privacy' });
  });

  test('off sends them unchanged', async () => {
    const { engine, rp } = setup([], [{ text: 'remote' }], { privacy: { secrets: 'off' } });
    const s = engine.createSession({});
    await engine.runTurn(s.id, `use ${TOKEN}`, 'remote');
    expect(sent(rp)).toContain(TOKEN);
  });
});
