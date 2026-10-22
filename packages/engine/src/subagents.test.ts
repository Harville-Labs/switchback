import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type ChatRequest, type Provider, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { taskTool } from './tools/task.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-subagents-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const isChild = (req: ChatRequest) => req.system.includes('# Reporting back');
const briefOf = (req: ChatRequest) => {
  const part = req.messages[0]?.parts[0];
  return part?.type === 'text' ? part.text : '';
};

/**
 * A parent that fans `tasks` out in one step, then answers with the reports it
 * got back. Children report `done: <brief's first line>` after `childMs`, or wait for
 * cancellation when `childMs` is undefined.
 */
function orchestrate(
  tasks: { agent: string; brief: string; model?: string }[],
  { childMs = 30, config = {} }: { childMs?: number | undefined; config?: object } = {},
) {
  let running = 0;
  let peak = 0;
  const lp = new ScriptedProvider('lp', 'local', (req) => {
    if (isChild(req)) return { text: `done: ${briefOf(req).split('\n')[0]}` };
    const results = req.messages.at(-1)?.parts.filter((p) => p.type === 'tool_result') ?? [];
    if (results.length)
      return { text: results.map((r) => (r.type === 'tool_result' ? r.content : '')).join(' | ') };
    return {
      toolCalls: tasks.map((t) => ({
        name: 'task',
        input: {
          agent: t.agent,
          description: t.brief,
          prompt: t.brief,
          ...(t.model ? { model: t.model } : {}),
        },
      })),
    };
  });
  const stream = lp.stream.bind(lp);
  lp.stream = async function* (req) {
    if (!isChild(req)) return yield* stream(req);
    running++;
    peak = Math.max(peak, running);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = childMs === undefined ? undefined : setTimeout(resolve, childMs);
        req.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      yield* stream(req);
    } finally {
      running--;
    }
  };
  const engine = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: {
        local: { provider: 'lp', model: 'small', contextWindow: 100_000 },
        coder: { provider: 'lp', model: 'coder', contextWindow: 100_000 },
      },
      routing: { current: ['local'], allowRemote: false },
      ...config,
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
  });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const of = <T extends EngineEvent['type']>(type: T) =>
    events.filter((e): e is Extract<EngineEvent, { type: T }> => e.type === type);
  return { engine, lp, events, of, peak: () => peak };
}

const four = ['a', 'b', 'c', 'd'].map((x) => ({ agent: 'explore', brief: `search ${x}` }));

describe('orchestrating subagents', () => {
  test('several task calls in one step run in parallel and all report back', async () => {
    const { engine, of, peak } = orchestrate(four);
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'use 4 subagents to search');
    expect(peak()).toBe(4);
    expect(of('subagent.queued')).toHaveLength(0);
    expect(of('subagent.completed').every((e) => e.ok)).toBe(true);
    // Every report reaches the parent, in the order the calls were made.
    expect(r.text).toBe('done: search a | done: search b | done: search c | done: search d');
  });

  test('calls beyond subagents.maxConcurrent queue, then start as slots free', async () => {
    const { engine, of, events, peak } = orchestrate(four, {
      config: { subagents: { maxConcurrent: 2 } },
    });
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'use 4 subagents to search');
    expect(peak()).toBe(2);
    const queued = of('subagent.queued').map((e) => e.task);
    expect(queued).toEqual(['search c', 'search d']);
    expect(of('subagent.started')).toHaveLength(4);
    // A queued subagent is announced before it starts.
    const at = (type: string, task: string) =>
      events.findIndex((e) => e.type === type && 'task' in e && e.task === task);
    expect(at('subagent.queued', 'search c')).toBeLessThan(at('subagent.started', 'search c'));
    expect(r.text).toContain('done: search d');
  });

  test("a named agent's settings and the parent's model choice apply to its run", async () => {
    const { engine, lp } = orchestrate(
      [
        { agent: 'scout', brief: 'scout it' },
        { agent: 'explore', brief: 'explore it', model: 'coder' },
      ],
      {
        config: {
          agents: {
            scout: {
              description: 'Scouts',
              prompt: 'You are a scout.',
              mode: 'subagent',
              tools: ['read'],
              model: 'coder',
              effort: 'high',
            },
          },
        },
      },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'send a scout and an explorer');
    const scout = lp.requests.find((q) => isChild(q) && q.system.startsWith('You are a scout.'));
    expect(scout?.model).toBe('coder');
    expect(scout?.effort).toBe('high');
    expect(scout?.tools.map((t) => t.name)).not.toContain('grep');
    expect(scout?.tools.map((t) => t.name)).toContain('read');
    const explore = lp.requests.find((q) => isChild(q) && briefOf(q) === 'explore it');
    expect(explore?.model).toBe('coder');
    expect(explore?.effort).toBe('low');
  });

  test('a long report is cut before it reaches the parent', async () => {
    const lp = new ScriptedProvider('lp', 'local', (req) => {
      if (isChild(req)) return { text: 'x'.repeat(50_000) };
      if (req.messages.at(-1)?.parts.some((p) => p.type === 'tool_result')) return { text: 'ok' };
      return {
        toolCalls: [{ name: 'task', input: { agent: 'explore', description: 'd', prompt: 'p' } }],
      };
    });
    const engine = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { local: { provider: 'lp', model: 'small', contextWindow: 1_000_000 } },
        routing: { current: ['local'], allowRemote: false },
      }),
      providers: new Map<string, Provider>([['lp', lp]]),
    });
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'go');
    const result = engine
      .getSession(s.id)
      .messages.flatMap((m) => m.parts)
      .find((p) => p.type === 'tool_result');
    expect(result?.type === 'tool_result' && result.content.length).toBeLessThan(31_000);
    expect(result?.type === 'tool_result' ? result.content : '').toContain('[truncated');
  });

  test('cancelling the parent cancels its running and queued subagents', async () => {
    const { engine, of } = orchestrate(four.slice(0, 3), {
      childMs: undefined,
      config: { subagents: { maxConcurrent: 2 } },
    });
    const s = engine.createSession({});
    engine.prompt({ sessionId: s.id, text: 'use 3 subagents' });
    for (let i = 0; i < 100 && of('subagent.started').length < 2; i++) await Bun.sleep(10);
    expect(of('subagent.queued')).toHaveLength(1);
    expect(engine.cancel(s.id)).toBe(true);
    for (let i = 0; i < 100 && of('subagent.completed').length < 3; i++) await Bun.sleep(10);
    const completed = of('subagent.completed');
    expect(completed).toHaveLength(3);
    expect(completed.every((e) => !e.ok)).toBe(true);
    // The queued one never got a slot.
    expect(of('subagent.started').map((e) => e.task)).toEqual(['search a', 'search b']);
    expect(engine.busy()).toBe(false);
  });

  test('150 subagents run within the cap, and their reports share one budget', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ agent: 'explore', brief: `part ${i}` }));
    const { engine, of, lp, peak } = orchestrate(many, { childMs: 1 });
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'use 150 subagents');
    expect(peak()).toBe(4);
    expect(of('subagent.queued')).toHaveLength(146);
    expect(of('subagent.completed').filter((e) => e.ok)).toHaveLength(150);
    // Each child is told its share: 60,000 characters across 150.
    const briefs = lp.requests.filter(isChild).map(briefOf);
    expect(briefs.every((b) => b.includes('under 400 characters'))).toBe(true);
  });

  test('a lone subagent gets the whole report budget and no length note', async () => {
    const { engine, lp } = orchestrate(four.slice(0, 1));
    await engine.runTurn(engine.createSession({}).id, 'go');
    expect(lp.requests.filter(isChild).map(briefOf)).toEqual(['search a']);
  });

  test('the task tool covers counts, agreeing on one, parallel pieces, and shared files', () => {
    const d = taskTool.description;
    expect(d).toContain('Start as many as the user asks for');
    expect(d).toContain('agree on one before starting');
    expect(d).toContain('in one response to run them in parallel');
    expect(d).toContain('Never let two edit the same file');
  });
});
