import { describe, expect, test } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { type CodexConnection, claudeModels, codexModels } from './model-lists.ts';

/** A Codex app server that answers from `pages`, in order. */
function fakeCodex(pages: object[], log: string[] = []) {
  let closed = false;
  const conn: CodexConnection = {
    request: async (method, params) => {
      log.push(`${method} ${JSON.stringify(params)}`);
      return method === 'model/list' ? pages.shift() : {};
    },
    notify: (method) => log.push(method),
    close: () => {
      closed = true;
    },
  };
  return { connect: () => conn, log, closed: () => closed };
}

describe('codexModels', () => {
  test('pages through model/list and leaves out hidden models', async () => {
    const codex = fakeCodex([
      {
        data: [
          { id: 'gpt-7', displayName: 'GPT-7' },
          { id: 'internal', hidden: true },
        ],
        nextCursor: 'p2',
      },
      { data: [{ id: 'gpt-7-mini' }], nextCursor: null },
    ]);
    expect(await codexModels({ executable: 'codex', connect: codex.connect })).toEqual([
      { id: 'gpt-7', label: 'GPT-7' },
      { id: 'gpt-7-mini' },
    ]);
    expect(codex.log).toEqual([
      expect.stringMatching(/^initialize /),
      'initialized',
      'model/list {}',
      'model/list {"cursor":"p2"}',
    ]);
    expect(codex.closed()).toBe(true);
  });

  test("can't tell when the server errors or answers something else", async () => {
    const codex = fakeCodex([{ unexpected: true }]);
    expect(await codexModels({ executable: 'codex', connect: codex.connect })).toBeUndefined();
    expect(codex.closed()).toBe(true);
  });

  test("can't tell when the server never answers", async () => {
    const never: CodexConnection = {
      request: () => new Promise(() => {}),
      notify: () => {},
      close: () => {},
    };
    expect(
      await codexModels({ executable: 'codex', connect: () => never, timeoutMs: 5 }),
    ).toBeUndefined();
  });
});

describe('claudeModels', () => {
  test('resolves aliases to model IDs, once each', async () => {
    let closed = false;
    const query = () =>
      ({
        supportedModels: async () => [
          { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
          { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 1M' },
          { value: 'claude-opus-5', displayName: 'Opus' },
          { value: 'default', displayName: 'Default' },
        ],
        close: () => {
          closed = true;
        },
      }) as unknown as Query;
    expect(await claudeModels({ query })).toEqual([
      { id: 'claude-sonnet-5', label: 'Sonnet' },
      { id: 'claude-opus-5', label: 'Opus' },
    ]);
    expect(closed).toBe(true);
  });

  test("can't tell when the CLI fails", async () => {
    const query = () =>
      ({
        supportedModels: async () => {
          throw new Error('not signed in');
        },
        close: () => {},
      }) as unknown as Query;
    expect(await claudeModels({ query })).toBeUndefined();
  });

  test("can't tell when no Claude Code binary is found", async () => {
    const query = () => {
      throw new Error('Native CLI binary for darwin-arm64 not found.');
    };
    expect(await claudeModels({ query })).toBeUndefined();
  });
});
