import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedProvider } from '@switchback/providers';
import { loadAgents, parseAgentFile } from './agents.ts';
import { loadConfig, SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import {
  DailyReport,
  dueDays,
  optIn,
  pendingReports,
  readTelemetryState,
  recordCrash,
  recordEngineEvent,
  scrubError,
  sendTelemetry,
  type TelemetryContext,
  telemetryPaths,
  writeTelemetryState,
} from './telemetry.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'switchback-telemetry-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('which days are reported', () => {
  test('complete days after opting in, not yet sent, oldest first', () => {
    const state = { installId: 'x', enabledAt: '2026-09-20T15:00:00Z' };
    expect(dueDays(state, '2026-09-23')).toEqual(['2026-09-20', '2026-09-21', '2026-09-22']);
    expect(dueDays({ ...state, sentThrough: '2026-09-21' }, '2026-09-23')).toEqual(['2026-09-22']);
    expect(dueDays(state, '2026-09-20')).toEqual([]);
  });
});

describe('reports contain no user content', () => {
  const SECRETS = [
    'the quarterly acquisition plan', // prompt text
    'project-falcon', // file name
    'acme-gpu-box', // provider ID
    'gpu.acme.internal', // server URL
    'acme-finetune-7b', // local model name
    'falcon-reviewer', // custom agent name
    'big-brain', // model alias
    'Top secret answer', // model output
  ];

  test('a real session’s report holds counts and Switchback-defined names only', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'switchback-telemetry-ws-'));
    try {
      writeFileSync(join(workspace, 'project-falcon.md'), 'the plan');
      const config = SwitchbackConfig.parse({
        providers: {
          'acme-gpu-box': {
            type: 'openai-compatible',
            tier: 'local',
            baseUrl: 'http://gpu.acme.internal:8000/v1',
          },
          rp: { type: 'mock', tier: 'remote' },
        },
        models: {
          local: { provider: 'acme-gpu-box', model: 'acme-finetune-7b', contextWindow: 32_000 },
          'big-brain': { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
        },
        routing: { start: 'local', escalate: ['big-brain'] },
      });
      const agent = parseAgentFile(
        '---\nname: falcon-reviewer\ndescription: Reviews falcon\n---\nReview it.',
        'falcon-reviewer.md',
        'project',
      );
      const engine = new Engine({
        workspaceRoot: workspace,
        config,
        providers: new Map([
          [
            'acme-gpu-box',
            new ScriptedProvider('acme-gpu-box', 'local', [
              { toolCalls: [{ name: 'read', input: { path: 'project-falcon.md' } }] },
              { text: 'Top secret answer' },
            ]),
          ],
          ['rp', new ScriptedProvider('rp', 'remote', [{ text: 'Top secret answer' }])],
        ]),
        agents: new Map([...loadAgents([]).agents, [agent.name, agent]]),
        now: () => new Date('2026-09-26T12:00:00Z'),
      });
      const events: Parameters<typeof recordEngineEvent>[1][] = [];
      engine.subscribe((e) => events.push(e));
      const s = engine.createSession({ agent: 'falcon-reviewer' });
      await engine.runTurn(s.id, 'Summarize the quarterly acquisition plan in @project-falcon.md');
      await engine.runTurn(s.id, 'the quarterly acquisition plan, deeper', 'remote');
      for (const e of events) recordEngineEvent(dir, e, new Date('2026-09-26T12:00:00Z'));
      recordCrash(
        dir,
        new Error(`ENOENT: no such file '/Users/me/project-falcon.md' at http://gpu.acme.internal`),
        new Date('2026-09-26T12:00:00Z'),
      );

      writeTelemetryState(dir, { installId: 'anon', enabledAt: '2026-09-26T00:00:00Z' });
      const [report] = pendingReports({
        dataDir: dir,
        config,
        organization: false,
        version: '0.6.0',
        ledger: engine.usageEntriesSince(''),
        now: new Date('2026-09-27T09:00:00Z'),
      });
      expect(report).toBeDefined();
      const json = JSON.stringify(report);
      for (const s of SECRETS) expect(json).not.toContain(s);
      expect(json).not.toContain('/Users/');
      // And it's still useful.
      expect(DailyReport.parse(report)).toMatchObject({
        day: '2026-09-26',
        calls: { local: 2, remote: 1 },
        providerTypes: ['mock', 'openai-compatible'],
        remoteModels: { 'claude-opus-5': 1 },
        turns: { end_turn: 2 },
      });
      expect(report?.byRule['user-override']?.remote).toBe(1);
      expect(report?.savingsUsd).toBeGreaterThan(0);
      expect(report?.allRemoteUsd).toBeCloseTo((report?.costUsd ?? 0) + (report?.savingsUsd ?? 0));
      expect(report?.crashes[0]?.message).toBe('ENOENT: no such file <str> at <url>');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('crash stacks keep function names and Switchback file names only', () => {
    const err = new Error('boom in /home/alice/code/secret-repo/x.ts');
    err.stack = [
      'Error: boom',
      '    at runTools (/home/alice/switchback/packages/engine/src/engine.ts:120:5)',
      '    at customerCode (/home/alice/code/secret-repo/x.ts:1:1)',
    ].join('\n');
    const s = scrubError(err);
    expect(s.message).toBe('boom in <path>');
    expect(s.stack).toBe('at runTools (packages/engine/src/engine.ts:120)\nat customerCode');
  });
});

describe('collection only while on', () => {
  test('nothing from before opting in, even the same day', () => {
    writeTelemetryState(dir, { installId: 'a', enabledAt: '2026-09-26T12:00:00Z' });
    const config = SwitchbackConfig.parse({});
    const entry = (ts: string) => ({
      ts,
      sessionId: 's',
      tier: 'local' as const,
      model: { provider: 'p', model: 'm' },
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0,
      savingsUsd: 0,
    });
    const [r] = pendingReports({
      dataDir: dir,
      config,
      organization: false,
      version: 'v',
      ledger: [entry('2026-09-26T08:00:00Z'), entry('2026-09-26T13:00:00Z')],
      now: new Date('2026-09-27T00:00:01Z'),
    });
    expect(r?.calls.local).toBe(1);
  });

  test('subagent turns are not counted separately', () => {
    recordEngineEvent(
      dir,
      {
        type: 'turn.completed',
        sessionId: 'c',
        parentSessionId: 'p',
        turnId: 't',
        stopReason: 'end_turn',
      },
      new Date(),
    );
    recordEngineEvent(
      dir,
      { type: 'turn.completed', sessionId: 'p', turnId: 't', stopReason: 'error' },
      new Date(),
    );
    expect(readFileSync(telemetryPaths(dir).counters, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('sending', () => {
  const ctx = (enabled: boolean): TelemetryContext => ({
    dataDir: dir,
    config: SwitchbackConfig.parse({ telemetry: { enabled, endpoint: 'https://t.example/v1' } }),
    organization: false,
    version: 'v',
    ledger: [],
    now: new Date('2026-09-27T12:00:00Z'),
  });

  test('posts due days, then remembers them and drops their counters', async () => {
    optIn(dir, new Date('2026-09-25T10:00:00Z'));
    recordEngineEvent(
      dir,
      { type: 'error', sessionId: 's', message: 'x' },
      new Date('2026-09-25T11:00:00Z'),
    );
    recordEngineEvent(
      dir,
      { type: 'error', sessionId: 's', message: 'x' },
      new Date('2026-09-27T11:00:00Z'),
    );
    const bodies: unknown[] = [];
    const fetchOk = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://t.example/v1');
      bodies.push(JSON.parse(init.body as string));
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;
    expect(await sendTelemetry(ctx(true), fetchOk)).toEqual({ sent: 2 });
    const sent = bodies[0] as { reports: DailyReport[] };
    expect(sent.reports.map((r) => r.day)).toEqual(['2026-09-25', '2026-09-26']);
    expect(sent.reports[0]?.errors).toBe(1);
    expect(readTelemetryState(dir)?.sentThrough).toBe('2026-09-26');
    // Today's counter stays for tomorrow.
    expect(readFileSync(telemetryPaths(dir).counters, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(await sendTelemetry(ctx(true), fetchOk)).toEqual({ sent: 0 });
  });

  test('signed in to a site, reports go to the site with the member’s token', async () => {
    optIn(dir, new Date('2026-09-25T10:00:00Z'));
    let seen: { url: string; auth: string | null } | undefined;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization') };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const r = await sendTelemetry(
      {
        ...ctx(true),
        site: { server: 'https://switchback.test/sites/acme/', accessToken: 'hsa_x' },
      },
      spy,
    );
    expect(r.sent).toBe(2);
    expect(seen).toEqual({
      url: 'https://switchback.test/sites/acme/v1/telemetry',
      auth: 'Bearer hsa_x',
    });
  });

  test('a failure changes nothing, and off sends nothing', async () => {
    optIn(dir, new Date('2026-09-25T10:00:00Z'));
    const failing = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await sendTelemetry(ctx(true), failing)).toEqual({ sent: 0, error: 'HTTP 503' });
    expect(readTelemetryState(dir)?.sentThrough).toBeUndefined();
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;
    await sendTelemetry(ctx(false), spy);
    expect(called).toBe(false);
  });
});

describe('config', () => {
  test('DO_NOT_TRACK and SWITCHBACK_TELEMETRY=0 force it off; a project can’t turn it on', () => {
    const home = join(dir, 'home');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, '.switchback'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const env = { SWITCHBACK_HOME: home };
    writeFileSync(join(ws, '.switchback', 'config.json'), '{"telemetry":{"enabled":true}}');
    expect(loadConfig(ws, env, [], null).config.telemetry.enabled).toBe(false);
    writeFileSync(join(home, 'config.json'), '{"telemetry":{"enabled":true}}');
    expect(loadConfig(ws, env, [], null).config.telemetry.enabled).toBe(true);
    expect(loadConfig(ws, { ...env, DO_NOT_TRACK: '1' }, [], null).config.telemetry.enabled).toBe(
      false,
    );
    expect(
      loadConfig(ws, { ...env, SWITCHBACK_TELEMETRY: '0' }, [], null).config.telemetry.enabled,
    ).toBe(false);
    // A project may still turn it off.
    writeFileSync(join(ws, '.switchback', 'config.json'), '{"telemetry":{"enabled":false}}');
    expect(loadConfig(ws, env, [], null).config.telemetry.enabled).toBe(false);
  });
});
