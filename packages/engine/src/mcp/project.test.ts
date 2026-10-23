import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { trust } from '../trust.ts';

let root: string;
let home: string;
let env: Record<string, string>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-mcp-project-'));
  home = join(root, 'home');
  env = { SWITCHBACK_HOME: home };
  mkdirSync(join(root, '.switchback'), { recursive: true });
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (file: string, value: unknown) =>
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
const mcpJson = (value: unknown) => write(join(root, '.mcp.json'), value);
const project = (value: unknown) => write(join(root, '.switchback', 'config.json'), value);
const user = (value: unknown) => write(join(home, 'config.json'), value);
const load = () => loadConfig(root, env, [], null);

describe('.mcp.json', () => {
  test("a project's .mcp.json servers start with the rest, without being trusted", () => {
    mcpJson({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'server-files'] },
        tickets: { type: 'http', url: 'https://mcp.example.com/tickets' },
      },
    });
    const { config, untrustedMcp, sources } = load();
    expect(config.mcpServers.files).toMatchObject({ command: 'npx', args: ['-y', 'server-files'] });
    expect(config.mcpServers.tickets).toMatchObject({ url: 'https://mcp.example.com/tickets' });
    expect(untrustedMcp).toEqual([]);
    // Not a Switchback config file: a repo with only .mcp.json still gets first-run setup.
    expect(sources).toEqual([]);
  });

  test('.switchback/config.json adjusts or turns off a .mcp.json server', () => {
    mcpJson({ mcpServers: { files: { command: 'npx' }, noisy: { command: 'noisy' } } });
    project({ mcpServers: { files: { permission: 'allow' }, noisy: { enabled: false } } });
    const { config } = load();
    expect(config.mcpServers.files).toMatchObject({ command: 'npx', permission: 'allow' });
    expect(config.mcpServers.noisy?.enabled).toBe(false);
  });

  test('.mcp.json env references read the environment; a default applies only when unset', () => {
    mcpJson({
      mcpServers: {
        gh: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: .mcp.json's own syntax
          url: 'https://${HOST:-api.example.com}/mcp',
          // biome-ignore lint/suspicious/noTemplateCurlyInString: .mcp.json's own syntax
          headers: { Authorization: 'Bearer ${GH_TOKEN}', Org: '${ORG:-acme}' },
        },
      },
    });
    env = { ...env, GH_TOKEN: 'secret', ORG: 'harville' };
    const gh = load().config.mcpServers.gh as { url: string; headers: Record<string, string> };
    expect(gh.url).toBe('https://api.example.com/mcp');
    expect(gh.headers).toEqual({ Authorization: 'Bearer secret', Org: 'harville' });
  });

  test("servers Switchback can't run, and a broken file, are warnings rather than errors", () => {
    mcpJson({
      mcpServers: {
        ok: { command: 'ok' },
        'has.dot': { command: 'x' },
        nothing: { type: 'stdio' },
      },
    });
    const loaded = load();
    expect(Object.keys(loaded.config.mcpServers)).toEqual(['ok']);
    expect(loaded.warnings).toHaveLength(2);
    expect(loaded.warnings[0]).toContain('server "has.dot" skipped');

    mcpJson('{ "mcpServers": ');
    const broken = load();
    expect(broken.config.mcpServers).toEqual({});
    expect(broken.warnings[0]).toMatch(/^\.mcp\.json: ignored, invalid JSON/);
  });

  test('in the home directory, ~/.mcp.json is not read as a project file', () => {
    // SWITCHBACK_HOME at <root>/.switchback makes <root> the home directory.
    env = { SWITCHBACK_HOME: join(root, '.switchback') };
    mcpJson({ mcpServers: { files: { command: 'npx' } } });
    expect(load().config.mcpServers).toEqual({});
  });
});

describe('requireMcpTrust', () => {
  test('when the user turns it on, project servers wait for trust, per definition', () => {
    user({ requireMcpTrust: true, mcpServers: { mine: { command: 'ok' } } });
    project({ mcpServers: { repo: { command: 'evil' } } });
    mcpJson({ mcpServers: { other: { command: 'x' } } });

    const before = load();
    expect(Object.keys(before.config.mcpServers)).toEqual(['mine']);
    expect(before.untrustedMcp).toEqual([
      { name: 'other', source: join(root, '.mcp.json'), definition: { command: 'x' } },
      {
        name: 'repo',
        source: join(root, '.switchback', 'config.json'),
        definition: { command: 'evil' },
      },
    ]);

    trust(root, { 'mcp:repo': { command: 'evil' }, 'mcp:other': { command: 'x' } }, env);
    expect(Object.keys(load().config.mcpServers).sort()).toEqual(['mine', 'other', 'repo']);

    // Changing the definition revokes trust.
    project({ mcpServers: { repo: { command: 'worse' } } });
    expect(load().untrustedMcp.map((u) => u.name)).toEqual(['repo']);

    // A project can't silently replace a user server's command either.
    project({ mcpServers: { repo: { command: 'evil' }, mine: { command: 'swap' } } });
    expect(load().untrustedMcp.map((u) => u.name)).toEqual(['mine']);
  });

  test('a project can turn it on but not off', () => {
    project({ requireMcpTrust: true, mcpServers: { repo: { command: 'evil' } } });
    expect(load().untrustedMcp.map((u) => u.name)).toEqual(['repo']);

    user({ requireMcpTrust: true });
    project({ requireMcpTrust: false, mcpServers: { repo: { command: 'evil' } } });
    const loaded = load();
    expect(loaded.config.requireMcpTrust).toBe(true);
    expect(loaded.untrustedMcp.map((u) => u.name)).toEqual(['repo']);
  });
});
