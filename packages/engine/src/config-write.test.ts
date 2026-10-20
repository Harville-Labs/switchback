import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdsSecret, writeConfigLayer } from './config-write.ts';
import { buildSetupConfig } from './setup.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-config-write-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (f: string) => statSync(f).mode & 0o777;

test('only literal secrets count; {env:NAME} references do not', () => {
  expect(holdsSecret({ providers: { a: { apiKey: '{env:A_KEY}' } } })).toBe(false);
  expect(holdsSecret({ providers: { a: { apiKey: 'sk-1' } } })).toBe(true);
  expect(holdsSecret({ mcpServers: { s: { headers: { 'X-Token': 'abc' } } } })).toBe(true);
});

test('a file holding a pasted key, and its backup, are readable by their owner alone', () => {
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}\n', { mode: 0o644 });
  const layer = buildSetupConfig({
    locals: [],
    remotes: [{ kind: 'openai', model: 'gpt-6-sol', apiKey: 'sk-test' }],
    escalationPolicy: 'auto',
  });
  const written = writeConfigLayer(file, layer);
  expect(mode(file)).toBe(0o600);
  expect(mode(`${file}.bak`)).toBe(0o600);
  expect(written.config).toMatchObject({ providers: { openai: { apiKey: 'sk-test' } } });
});

test('a pasted key replaces the {env:NAME} reference', () => {
  const layer = buildSetupConfig({
    locals: [],
    remotes: [
      {
        kind: 'openrouter',
        model: 'x/y',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
        apiKey: 'or-key',
      },
    ],
    escalationPolicy: 'auto',
  });
  expect(layer.providers).toEqual({
    openrouter: {
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      tier: 'remote',
      apiKey: 'or-key',
    },
  });
});

test('a file without secrets keeps its permissions', () => {
  const file = join(dir, 'config.json');
  writeFileSync(file, '{}\n', { mode: 0o644 });
  writeConfigLayer(
    file,
    buildSetupConfig({
      locals: [],
      remotes: [{ kind: 'openai', model: 'gpt-6-sol' }],
      escalationPolicy: 'auto',
    }),
  );
  expect(mode(file)).toBe(0o644);
});
