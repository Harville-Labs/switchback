import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { parseAgentFile } from '../agents.ts';
import { loadConfig, SwitchbackConfig } from '../config.ts';
import { Engine, type EngineOptions } from '../engine.ts';
import { trust } from '../trust.ts';
import { fromContent } from './content.ts';
import { allowsMcpTool, McpHub, mcpToolName } from './hub.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'test-server.ts');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-mcp-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const server = (extra: object = {}) => ({
  command: process.execPath,
  args: [FIXTURE],
  env: { NOTE_FILE: join(root, 'note.txt') },
  ...extra,
});

function engine(script: Script, config: object, opts: Partial<EngineOptions> = {}) {
  const lp = new ScriptedProvider('lp', 'local', script);
  const e = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000 } },
      routing: { start: ['local'], allowRemote: false },
      ...config,
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
    ...opts,
  });
  const events: EngineEvent[] = [];
  e.subscribe((ev) => events.push(ev));
  return { e, lp, events };
}

describe('helpers', () => {
  test('tool names follow Claude Code and fit provider limits', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
    expect(mcpToolName('a.b', 'x y')).toBe('mcp__a_b__x_y');
    expect(mcpToolName('s', 'x'.repeat(100))).toHaveLength(64);
    expect(allowsMcpTool(['mcp__github'], 'mcp__github__create_issue')).toBe(true);
    expect(allowsMcpTool(['mcp__github__list'], 'mcp__github__create_issue')).toBe(false);
    expect(allowsMcpTool(['mcp__git'], 'mcp__github__x')).toBe(false);
  });

  test('content keeps text and images, and describes the rest', () => {
    const r = fromContent(
      [
        { type: 'text', text: 'hi' },
        { type: 'image', mimeType: 'image/png', data: 'not a png' },
        { type: 'audio', mimeType: 'audio/wav', data: '...' },
      ],
      'x',
    );
    expect(r.images).toEqual([]);
    expect(r.text).toContain('hi\n[image omitted:');
    expect(r.text).toContain('[audio content (audio/wav) omitted]');
  });
});

describe('stdio server', () => {
  test('lists tools with stable names and statuses', async () => {
    const hub = new McpHub(
      { test: SwitchbackConfig.parse({ mcpServers: { test: server() } }).mcpServers.test as never },
      root,
    );
    await hub.ready;
    expect(hub.tools().map((t) => t.name)).toEqual([
      'mcp__test__add',
      'mcp__test__fail',
      'mcp__test__note',
      'mcp__test__pic',
      'mcp__test__read_resource',
    ]);
    expect(hub.status()).toEqual([
      {
        name: 'test',
        state: 'connected',
        tools: 5,
        resources: [
          {
            uri: 'test://readme',
            name: 'readme',
            description: 'The readme',
            mimeType: 'text/markdown',
          },
          { uri: 'test://dot', name: 'dot', mimeType: 'image/png' },
        ],
        prompts: [
          {
            name: 'review',
            description: 'Review a file',
            arguments: [{ name: 'file', required: true }, { name: 'focus' }],
          },
        ],
      },
    ]);
    expect(hub.tools().find((t) => t.name === 'mcp__test__add')?.mutating).toBe(false);
    expect(hub.tools().find((t) => t.name === 'mcp__test__read_resource')?.description).toContain(
      '- test://readme',
    );
    await hub.close();
  }, 20_000);

  test('@server:uri attaches a resource; /server:prompt runs a prompt', async () => {
    const { e, lp, events } = engine([{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }], {
      mcpServers: { test: server() },
      models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000, vision: true } },
    });
    expect(await e.listCommands()).toContainEqual({
      name: 'test:review',
      description: 'Review a file',
      args: '<file> [focus]',
      source: 'mcp',
    });
    const s = e.createSession({});
    await e.runTurn(s.id, 'summarize @test:test://readme and @test:test://dot');
    const parts = lp.requests[0]?.messages[0]?.parts ?? [];
    expect(parts[1]).toMatchObject({ type: 'text', attachment: { path: 'test:test://readme' } });
    expect(JSON.stringify(parts[1])).toContain('It adds numbers.');
    expect(parts[2]).toMatchObject({ type: 'image', attachment: { path: 'test:test://dot' } });

    await e.runTurn(s.id, '/test:review src/a.ts errors');
    expect(lp.requests[1]?.messages.at(-1)?.parts[0]).toEqual({
      type: 'text',
      text: 'Review src/a.ts, focusing on errors.',
    });

    // A prompt missing its argument fails the turn, which still ends.
    const r = await e.runTurn(s.id, '/test:review');
    expect(r.stopReason).toBe('error');
    expect(events.some((ev) => ev.type === 'error' && ev.message.includes('<file> [focus]'))).toBe(
      true,
    );
    await e.shutdown();
  }, 20_000);

  test("a tool's images and a read resource's image reach the model", async () => {
    const { e, lp } = engine(
      [
        {
          toolCalls: [
            { name: 'mcp__test__pic', input: {} },
            { name: 'mcp__test__read_resource', input: { uri: 'test://readme' } },
          ],
        },
        { text: 'done' },
      ],
      {
        mcpServers: { test: server({ permission: 'allow' }) },
        models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000, vision: true } },
      },
    );
    await e.runTurn(e.createSession({}).id, 'draw');
    const results = lp.requests[1]?.messages.at(-1)?.parts ?? [];
    expect(results[0]).toMatchObject({ content: 'a dot', images: [{ mediaType: 'image/png' }] });
    expect(JSON.stringify(results[1])).toContain('It adds numbers.');
    await e.shutdown();
  }, 20_000);

  test('a model calls an MCP tool; the result comes back; permission ask is honored', async () => {
    const { e, lp, events } = engine(
      [{ toolCalls: [{ name: 'mcp__test__add', input: { a: 2, b: 3 } }] }, { text: 'done' }],
      { mcpServers: { test: server() } },
      { interaction: 'approve' },
    );
    await e.runTurn(e.createSession({}).id, 'add');
    expect(lp.requests[0]?.tools.map((t) => t.name)).toContain('mcp__test__add');
    expect(
      lp.requests[0]?.tools.find((t) => t.name === 'mcp__test__add')?.inputSchema,
    ).toMatchObject({
      properties: { a: { type: 'number' } },
    });
    expect(events.find((ev) => ev.type === 'tool.completed')).toMatchObject({
      name: 'mcp__test__add',
      output: '5',
      isError: false,
    });
    await e.shutdown();
  }, 20_000);

  test('errors, invalid arguments, and denial', async () => {
    const { e, events } = engine(
      [
        {
          toolCalls: [
            { name: 'mcp__test__fail', input: {} },
            { name: 'mcp__test__add', input: { a: 'two' } },
          ],
        },
        { toolCalls: [{ name: 'mcp__test__note', input: { text: 'secret' } }] },
        { text: 'done' },
      ],
      { mcpServers: { test: server({ permission: 'allow' }) }, permissions: { mcp: 'ask' } },
      { interaction: 'deny' },
    );
    await e.runTurn(e.createSession({}).id, 'go');
    const done = events.filter((ev) => ev.type === 'tool.completed');
    expect(done.map((d) => [d.name, d.isError])).toEqual([
      ['mcp__test__fail', true],
      ['mcp__test__add', true],
      ['mcp__test__note', false],
    ]);
    expect(done[0]?.output).toContain('something broke');
    // The server's `permission: allow` let `note` run without asking.
    expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('secret');
    await e.shutdown();
  }, 20_000);

  test('an org-enforced deny beats a server-level allow', async () => {
    const { e } = engine(
      [{ toolCalls: [{ name: 'mcp__test__note', input: { text: 'x' } }] }, { text: 'done' }],
      { mcpServers: { test: server({ permission: 'allow' }) }, permissions: { mcp: 'deny' } },
      { interaction: 'approve' },
    );
    await e.runTurn(e.createSession({}).id, 'go');
    expect(existsSync(join(root, 'note.txt'))).toBe(false);
    await e.shutdown();
  }, 20_000);

  test('agent tool lists select MCP tools by server or by name', async () => {
    const agent = parseAgentFile(
      '---\nname: notes\ndescription: d\ntools: Read, mcp__test__add\n---\nprompt',
      'notes.md',
      'project',
    );
    expect(agent?.tools).toEqual(['read', 'mcp__test__add']);
    const { e, lp } = engine(
      [{ text: 'hi' }],
      { mcpServers: { test: server() } },
      {
        agents: new Map([[agent.name, agent]]),
      },
    );
    await e.runTurn(e.createSession({ agent: 'notes' }).id, 'x');
    // exit_plan_mode, todo, skill, and docs aren't agent capabilities; sessions always have them.
    expect(lp.requests[0]?.tools.map((t) => t.name)).toEqual([
      'read',
      'exit_plan_mode',
      'todo',
      'skill',
      'docs',
      'mcp__test__add',
    ]);
    await e.shutdown();
  }, 20_000);

  test('a server that fails to start is reported, and the rest still work', async () => {
    const { e } = engine([{ text: 'ok' }], {
      mcpServers: { test: server(), broken: { command: '/nonexistent/binary' } },
    });
    const status = await e.mcpStatus();
    expect(status.servers.find((s) => s.name === 'test')).toMatchObject({ state: 'connected' });
    expect(status.servers.find((s) => s.name === 'broken')).toMatchObject({ state: 'failed' });
    await e.shutdown();
  }, 20_000);
});

describe('project servers need trust', () => {
  test("a project's servers are held back until trusted; another tool's .mcp.json is never read", () => {
    const home = join(root, 'home');
    const env = { SWITCHBACK_HOME: home };
    const project = (servers: Record<string, unknown>) =>
      writeFileSync(
        join(root, '.switchback', 'config.json'),
        JSON.stringify({ mcpServers: servers }),
      );
    mkdirSync(join(root, '.switchback'), { recursive: true });
    project({ repo: { command: 'evil' } });
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ mcpServers: { mine: { command: 'ok' } } }),
    );

    const before = loadConfig(root, env, [], null);
    expect(Object.keys(before.config.mcpServers)).toEqual(['mine']);
    expect(before.untrustedMcp).toEqual([
      {
        name: 'repo',
        source: join(root, '.switchback', 'config.json'),
        definition: { command: 'evil' },
      },
    ]);

    trust(root, { 'mcp:repo': { command: 'evil' } }, env);
    expect(Object.keys(loadConfig(root, env, [], null).config.mcpServers).sort()).toEqual([
      'mine',
      'repo',
    ]);

    // Changing the definition revokes trust.
    project({ repo: { command: 'worse' } });
    expect(loadConfig(root, env, [], null).untrustedMcp.map((u) => u.name)).toEqual(['repo']);

    // A project can't silently replace a user server's command either.
    project({ repo: { command: 'evil' }, mine: { command: 'swap' } });
    expect(loadConfig(root, env, [], null).untrustedMcp.map((u) => u.name)).toEqual(['mine']);
  });
});
