/**
 * Live tests against real models. Skipped unless SWITCHBACK_LIVE=1.
 *
 *   SWITCHBACK_LIVE=1 bun run test:live
 *
 * Local model: SWITCHBACK_LIVE_LOCAL_URL + SWITCHBACK_LIVE_LOCAL_MODEL, or the first
 * tool-capable model on a detected local server.
 * Remote models: every hosted provider with credentials in the environment
 * (OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY) runs the same
 * scenarios on its smallest catalog model. Providers are treated identically.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, SwitchbackConfig } from '@switchback/engine';
import type { EngineEvent } from '@switchback/protocol';
import {
  CATALOG,
  CREDENTIAL_ENV,
  detectLocalServers,
  type HostedProviderKind,
} from '@switchback/providers';

const LIVE = process.env.SWITCHBACK_LIVE === '1';
const TIMEOUT = 300_000;

async function findLocal(): Promise<
  { baseUrl: string; model: string; contextWindow?: number } | undefined
> {
  if (process.env.SWITCHBACK_LIVE_LOCAL_URL && process.env.SWITCHBACK_LIVE_LOCAL_MODEL) {
    return {
      baseUrl: process.env.SWITCHBACK_LIVE_LOCAL_URL,
      model: process.env.SWITCHBACK_LIVE_LOCAL_MODEL,
    };
  }
  for (const server of await detectLocalServers()) {
    const m = server.models.find((x) => x.tools !== false);
    if (m)
      return {
        baseUrl: server.baseUrl,
        model: m.id,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      };
  }
  return undefined;
}

const local = LIVE ? await findLocal() : undefined;
const hosted = (Object.keys(CATALOG) as HostedProviderKind[]).filter((k) => {
  const env = CREDENTIAL_ENV[k];
  return LIVE && env && process.env[env];
});

const spend: { provider: string; costUsd: number }[] = [];
afterAll(() => {
  if (spend.length)
    console.log(
      'live test spend:',
      spend.map((s) => `${s.provider} $${s.costUsd.toFixed(4)}`).join(', '),
    );
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-live-'));
  writeFileSync(join(root, 'secret.txt'), 'The launch code is PELICAN-42.\n');
  writeFileSync(
    join(root, 'math.ts'),
    'export function addNumbers(a: number, b: number) {\n  return a + b;\n}\n',
  );
});

function engineFor(
  models: Record<string, unknown>,
  providers: Record<string, unknown>,
  // Typed, so a removed routing key fails to compile instead of being dropped.
  routing: { start?: string[]; escalate?: string[][]; allowRemote?: boolean } = {},
) {
  const config = SwitchbackConfig.parse({
    providers,
    models,
    routing,
    permissions: { read: 'allow', edit: 'allow', bash: 'deny' },
    maxStepsPerTurn: 12,
  });
  const engine = new Engine({ workspaceRoot: root, config, interaction: 'approve' });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, events };
}

async function scenarioRead(engine: Engine, events: EngineEvent[], route: 'local' | 'remote') {
  const s = engine.createSession({});
  const r = await engine.runTurn(
    s.id,
    'Read secret.txt with the read tool and tell me the launch code.',
    route,
  );
  expect(r.stopReason).toBe('end_turn');
  expect(events.some((e) => e.type === 'tool.started' && e.name === 'read')).toBe(true);
  expect(r.text).toContain('PELICAN-42');
  return s.id;
}

async function scenarioEdit(engine: Engine, route: 'local' | 'remote') {
  const s = engine.createSession({});
  const r = await engine.runTurn(
    s.id,
    'In math.ts, rename the function addNumbers to sum using the edit tool. Change nothing else.',
    route,
  );
  expect(r.stopReason).toBe('end_turn');
  const text = readFileSync(join(root, 'math.ts'), 'utf8');
  expect(text).toContain('function sum(');
  expect(text).not.toContain('addNumbers');
}

async function scenarioDelegate(engine: Engine, events: EngineEvent[], route: 'local' | 'remote') {
  const s = engine.createSession({});
  const r = await engine.runTurn(
    s.id,
    'Use the task tool with the explore agent to find which file defines addNumbers, then tell me the file name.',
    route,
  );
  expect(r.stopReason).toBe('end_turn');
  expect(events.some((e) => e.type === 'subagent.started' && e.agent === 'explore')).toBe(true);
  expect(r.text).toContain('math.ts');
}

describe.skipIf(!LIVE || !local)('local model', () => {
  const setup = () =>
    engineFor(
      {
        local: {
          provider: 'local',
          model: local?.model,
          ...(local?.contextWindow ? { contextWindow: local.contextWindow } : {}),
        },
      },
      { local: { type: 'openai-compatible', baseUrl: local?.baseUrl, tier: 'local' } },
      { start: ['local'], allowRemote: false },
    );

  test(
    'reads a file and answers from it',
    async () => {
      const { engine, events } = setup();
      await scenarioRead(engine, events, 'local');
    },
    TIMEOUT,
  );

  test(
    'edits a file',
    async () => {
      const { engine } = setup();
      await scenarioEdit(engine, 'local');
    },
    TIMEOUT,
  );

  // Small models (like the 1.7B one in weekly CI) rarely delegate; opt in with a stronger model.
  test.skipIf(!process.env.SWITCHBACK_LIVE_LOCAL_DELEGATION)(
    'delegates to the explore subagent',
    async () => {
      const { engine, events } = setup();
      await scenarioDelegate(engine, events, 'local');
    },
    TIMEOUT,
  );
});

for (const kind of hosted) {
  const model = [...CATALOG[kind].models].sort((a, b) => a.price.output - b.price.output)[0];
  describe(`${kind} (${model?.id})`, () => {
    const remoteModel = {
      provider: kind,
      model: model?.id,
      contextWindow: model?.contextWindow,
      maxOutputTokens: 4000,
      ...(kind === 'deepseek' ? { effort: 'high' } : {}),
    };

    test(
      'reads a file and answers from it',
      async () => {
        const { engine, events } = engineFor(
          { remote: remoteModel },
          { [kind]: { type: kind } },
          { start: ['remote'] },
        );
        const id = await scenarioRead(engine, events, 'remote');
        const cost = engine.getSession(id).session.costUsd;
        expect(cost).toBeGreaterThan(0);
        spend.push({ provider: kind, costUsd: cost });
      },
      TIMEOUT,
    );

    test(
      'edits a file',
      async () => {
        const { engine } = engineFor(
          { remote: remoteModel },
          { [kind]: { type: kind } },
          { start: ['remote'] },
        );
        await scenarioEdit(engine, 'remote');
      },
      TIMEOUT,
    );

    test(
      'delegates to the explore subagent',
      async () => {
        const { engine, events } = engineFor(
          { remote: remoteModel },
          { [kind]: { type: kind } },
          { start: ['remote'] },
        );
        await scenarioDelegate(engine, events, 'remote');
      },
      TIMEOUT,
    );

    test.skipIf(!local)(
      'continues a local session after escalation (cross-provider history)',
      async () => {
        const { engine, events } = engineFor(
          {
            local: { provider: 'local', model: local?.model, contextWindow: 4096 },
            remote: remoteModel,
          },
          {
            local: { type: 'openai-compatible', baseUrl: local?.baseUrl, tier: 'local' },
            [kind]: { type: kind },
          },
        );
        const id = await scenarioRead(engine, events, 'local');
        // The same session, now too big for the (declared) 4K local window, must escalate
        // and still make sense of the local model's tool calls and results.
        const r = await engine.runTurn(
          id,
          `${'Context padding. '.repeat(1200)}\nWhat was the launch code you found? Answer directly.`,
        );
        expect(r.stopReason).toBe('end_turn');
        expect(r.text).toContain('PELICAN-42');
        expect(
          events.some(
            (e) =>
              e.type === 'route.decided' && e.rule === 'context-overflow' && e.tier === 'remote',
          ),
        ).toBe(true);
      },
      TIMEOUT,
    );
  });
}

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
