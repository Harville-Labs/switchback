import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { loadAgents, parseAgentFile } from '../agents.ts';
import { SwitchbackConfig } from '../config.ts';
import { Engine, type EngineOptions } from '../engine.ts';
import { ClaudeAgentSdkRuntime } from './claude-agent-sdk.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-rt-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Behaves like the SDK's query: streams messages, asks before an Edit, then reports cost. */
function fakeQuery(calls: { prompt: string; options?: Options }[]) {
  return async function* (params: {
    prompt: string;
    options?: Options;
  }): AsyncIterable<SDKMessage> {
    calls.push(params);
    yield {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'text', text: 'Looking. ' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } },
        ],
      },
    } as unknown as SDKMessage;
    const decision = await params.options?.canUseTool?.('Edit', { file_path: 'a.ts' }, {
      signal: new AbortController().signal,
    } as never);
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: decision?.behavior === 'allow' ? 'edited' : 'denied',
            is_error: decision?.behavior !== 'allow',
          },
        ],
      },
    } as unknown as SDKMessage;
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: decision?.behavior === 'allow' ? 'Fixed the bug in a.ts.' : 'Could not edit.',
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 0,
          costUSD: 0.0123,
        },
      },
    } as unknown as SDKMessage;
  };
}

function engine(opts: Partial<Omit<EngineOptions, 'config'>> & { config?: object } = {}) {
  const calls: { prompt: string; options?: Options }[] = [];
  const agent = parseAgentFile(
    '---\nname: claude-coder\ndescription: Runs Claude Code\nruntime: claude\nbudgetUsd: 1\n---\nunused',
    'claude-coder.md',
    'project',
  );
  const lp = new ScriptedProvider('lp', 'local', (req) =>
    req.messages.at(-1)?.parts.some((p) => p.type === 'tool_result')
      ? { text: 'parent done' }
      : {
          toolCalls: [
            {
              name: 'task',
              input: { agent: 'claude-coder', description: 'fix', prompt: 'fix a.ts' },
            },
          ],
        },
  );
  const { config, ...rest } = opts;
  const e = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'm', contextWindow: 100_000 } },
      runtimes: { claude: { type: 'claude-agent-sdk', model: 'claude-sonnet-5' } },
      ...config,
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
    agents: new Map([...loadAgents([]).agents, [agent.name, agent]]),
    runtimes: new Map([
      [
        'claude',
        new ClaudeAgentSdkRuntime({
          name: 'claude',
          model: 'claude-sonnet-5',
          query: fakeQuery(calls),
        }),
      ],
    ]),
    ...rest,
  });
  const events: EngineEvent[] = [];
  e.subscribe((ev) => events.push(ev));
  return { e, events, calls };
}

describe('external runtime as a subagent', () => {
  test('runs, streams progress on the child session, asks permission, and ledgers the reported cost', async () => {
    const { e, events, calls } = engine({ interaction: 'approve' });
    const s = e.createSession({});
    const r = await e.runTurn(s.id, 'go');
    expect(r.text).toBe('parent done');

    const child = events.find((ev) => ev.type === 'subagent.started') as { childSessionId: string };
    const childEvents = events.filter(
      (ev) => 'sessionId' in ev && ev.sessionId === child.childSessionId,
    );
    expect(childEvents.find((ev) => ev.type === 'route.decided')).toMatchObject({
      tier: 'remote',
      rule: 'runtime',
      reason: 'agent "claude-coder" runs on the Claude Agent SDK',
    });
    expect(childEvents.filter((ev) => ev.type === 'tool.completed')).toMatchObject([
      { name: 'Edit', output: 'edited', isError: false },
    ]);

    // Options passed to the SDK: workspace, the agent's budget, Switchback answering permissions.
    expect(calls[0]?.prompt).toBe('fix a.ts');
    expect(calls[0]?.options).toMatchObject({
      cwd: root,
      maxBudgetUsd: 1,
      permissionMode: 'default',
      model: 'claude-sonnet-5',
    });

    const report = e
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report?.type === 'tool_result' && report.content).toBe('Fixed the bug in a.ts.');
    const row = e.usage('today').byRule?.find((x) => x.key === 'runtime');
    expect(row?.costUsd).toBeCloseTo(0.0123);
    expect(e.usage('today').byModel?.map((x) => x.key)).toContain('claude/claude-sonnet-5');
  });

  test('the permission policy applies to the runtime’s tools', async () => {
    const { e } = engine({ interaction: 'approve', config: { permissions: { edit: 'deny' } } });
    const s = e.createSession({});
    await e.runTurn(s.id, 'go');
    const report = e
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report?.type === 'tool_result' && report.content).toBe('Could not edit.');
  });

  test('local-only routing never starts an external runtime', async () => {
    const { e, calls } = engine({
      interaction: 'approve',
      config: { routing: { mode: 'local-only' } },
    });
    const s = e.createSession({});
    await e.runTurn(s.id, 'go');
    expect(calls).toHaveLength(0);
    const report = e
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report?.type === 'tool_result' && report.content).toContain('local-only');
  });

  test('a runtime may not touch private files, whatever the permission policy', async () => {
    const { e } = engine({
      interaction: 'approve',
      config: { privacy: { localOnlyPaths: ['a.ts'] } },
    });
    const s = e.createSession({});
    await e.runTurn(s.id, 'go');
    const report = e
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report?.type === 'tool_result' && report.content).toBe('Could not edit.');
  });

  test('a private session never starts an external runtime', async () => {
    const { e, calls } = engine({
      interaction: 'approve',
      config: { privacy: { localOnlyPaths: ['secret.txt'] } },
    });
    Bun.write(join(root, 'secret.txt'), 'hunter2');
    const s = e.createSession({});
    await e.runTurn(s.id, 'go, see @secret.txt');
    expect(calls).toHaveLength(0);
    const report = e
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(report?.type === 'tool_result' && report.content).toContain('never leaves this machine');
  });
});
