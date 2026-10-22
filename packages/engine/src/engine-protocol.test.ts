import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import { createTransportPair, type EngineEvent } from '@switchback/protocol';
import { engineFixture } from './engine-fixture.ts';
import { serve } from './server.ts';

const { ws, setup } = engineFixture();

describe('protocol round-trip', () => {
  test('client drives the engine over a transport', async () => {
    const { engine } = setup([{ text: 'over the wire' }], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    const init = await client.initialize({ name: 'test', version: '0' }, ws.root);
    expect(init.agents.map((a) => a.name)).toContain('explore');

    const session = await client.request('session.create', {});
    const done = new Promise<EngineEvent[]>((resolve) => {
      const seen: EngineEvent[] = [];
      client.on((e) => {
        seen.push(e);
        if (e.type === 'turn.completed') resolve(seen);
      });
    });
    await client.request('session.prompt', { sessionId: session.id, text: 'hi' });
    const events = await done;
    const text = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('over the wire');
  });

  test('session.setMode and permissions.list round-trip', async () => {
    const { engine } = setup([], [], { config: { permissions: { deny: ['bash(rm:*)'] } } });
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await client.initialize({ name: 'test', version: '0' }, ws.root);
    const session = await client.request('session.create', { permissionMode: 'plan' });
    expect(session.permissionMode).toBe('plan');
    const changed = new Promise<EngineEvent>((resolve) =>
      client.on((e) => e.type === 'mode.changed' && resolve(e)),
    );
    await client.request('session.setMode', { sessionId: session.id, mode: 'acceptEdits' });
    expect(await changed).toMatchObject({ mode: 'acceptEdits', sessionId: session.id });
    const p = await client.request('permissions.list', { sessionId: session.id });
    expect(p.mode).toBe('acceptEdits');
    expect(p.rules).toEqual([{ rule: 'bash(rm:*)', behavior: 'deny', source: 'config' }]);
  });

  test('rejects calls before initialize', async () => {
    const { engine } = setup([], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await expect(client.request('session.list', {})).rejects.toThrow('initialize');
  });

  test('daemon.retire works before initialize, checks the token, and reports back', async () => {
    const { engine } = setup([], []);
    const retired: string[] = [];
    const connect = (options: Parameters<typeof serve>[3]) => {
      const [serverSide, clientSide] = createTransportPair();
      serve(engine, serverSide, undefined, options);
      return new SwitchbackClient(clientSide);
    };
    // A private engine is never a shared daemon.
    expect(await connect({}).request('daemon.retire', { token: 'x' })).toEqual({
      retired: false,
      reason: 'not a shared engine',
    });
    const shared = {
      token: 'secret',
      ownsEngine: false,
      retire: () => ({ retired: true }),
      onRetired: () => retired.push('retired'),
    };
    await expect(connect(shared).request('daemon.retire', { token: 'wrong' })).rejects.toThrow(
      'invalid daemon token',
    );
    expect(retired).toEqual([]);
    expect(await connect(shared).request('daemon.retire', { token: 'secret' })).toEqual({
      retired: true,
    });
    expect(retired).toEqual(['retired']);
  });
});

describe('session roles', () => {
  test('a session can change its roles; others keep the config', async () => {
    const { engine, rp, events } = setup(
      [{ text: 'local' }, { text: 'local again' }],
      [{ text: 'remote' }],
    );
    const a = engine.createSession({});
    const b = engine.createSession({});
    const roles = engine.setRoles({ sessionId: a.id, current: ['remote'] });
    expect(roles).toMatchObject({
      current: ['remote'],
      escalate: [['remote']],
      overridden: ['current'],
    });
    expect(events.find((e) => e.type === 'roles.updated')).toMatchObject({ sessionId: a.id });
    expect((await engine.runTurn(a.id, 'hi')).text).toBe('remote');
    expect((await engine.runTurn(b.id, 'hi')).text).toBe('local');
    expect(rp.requests).toHaveLength(1);
    // Reset follows the config again.
    expect(engine.setRoles({ sessionId: a.id, reset: true }).overridden).toEqual([]);
    expect((await engine.runTurn(a.id, 'again')).text).toBe('local again');
  });

  test('route events say where the session is on the ladder', async () => {
    const { engine, events } = setup([{ text: 'ok' }], []);
    await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({ step: 0, steps: 1 });
  });

  test('unknown models are refused, and an organization can lock a role', () => {
    const { engine } = setup([], []);
    const s = engine.createSession({});
    expect(() => engine.setRoles({ sessionId: s.id, current: ['ghost'] })).toThrow(
      '"ghost" is not a configured model',
    );
    const org = setup([], [], {
      org: {
        id: 'acme',
        name: 'Acme',
        version: '1',
        notes: [],
        enforcedKeys: ['routing.escalate'],
        remoteDisabled: false,
        bypassDisabled: false,
        userPermissionsDisabled: false,
      },
    });
    const o = org.engine.createSession({});
    expect(() => org.engine.setRoles({ sessionId: o.id, escalate: [['local']] })).toThrow(
      "Acme's policy sets routing.escalate",
    );
    expect(org.engine.setRoles({ sessionId: o.id, current: ['remote'] }).current).toEqual([
      'remote',
    ]);
  });

  test('save writes the roles to the user config as the default', () => {
    const file = join(ws.root, 'user-config.json');
    const { engine } = setup([], [], { userConfigFile: file });
    const s = engine.createSession({});
    const r = engine.setRoles({
      sessionId: s.id,
      escalate: [['remote']],
      review: { mode: 'auto', models: [['remote']] },
      save: true,
    });
    expect(r.savedTo).toBe(file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.routing).toEqual({ current: ['local'], escalate: [['remote']] });
    expect(saved.review).toEqual({ mode: 'auto', models: [['remote']] });
  });

  test('over the protocol', async () => {
    const { engine } = setup([], []);
    const [serverSide, clientSide] = createTransportPair();
    serve(engine, serverSide);
    const client = new SwitchbackClient(clientSide);
    await client.initialize({ name: 'test', version: '0' }, ws.root);
    const session = await client.request('session.create', {});
    expect(await client.request('session.roles', { sessionId: session.id })).toMatchObject({
      current: ['local'],
      overridden: [],
    });
    const changed = await client.request('session.setRoles', {
      sessionId: session.id,
      subagents: 'local',
    });
    expect(changed).toMatchObject({ subagents: 'local', overridden: ['subagents'] });
  });
});

describe('headless sessions', () => {
  test('instructions join the system prompt; a refused call is marked denied', async () => {
    const { engine, lp, events } = setup(
      [{ toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] }, { text: 'ok' }],
      [],
    );
    const s = engine.createSession({ instructions: 'Answer in one line.' });
    await engine.runTurn(s.id, 'go');
    expect(lp.requests[0]?.system).toContain(
      '# Instructions for this session\nAnswer in one line.',
    );
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ denied: true });
  });
});

test('session.checkpoints and session.rewind round-trip', async () => {
  const { engine } = setup(
    [
      { toolCalls: [{ name: 'write', input: { path: 'hello.txt', content: 'changed\n' } }] },
      { text: 'ok' },
    ],
    [],
  );
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new SwitchbackClient(clientSide);
  await client.initialize({ name: 'test', version: '0' }, ws.root);
  const session = await client.request('session.create', {});
  const done = new Promise<void>((resolve) =>
    client.on((e) => e.type === 'turn.completed' && resolve()),
  );
  await client.request('session.prompt', { sessionId: session.id, text: 'change hello' });
  await done;
  const [checkpoint] = await client.request('session.checkpoints', { sessionId: session.id });
  expect(checkpoint).toMatchObject({ prompt: 'change hello', files: ['hello.txt'] });
  const r = await client.request('session.rewind', {
    sessionId: session.id,
    turnId: checkpoint?.turnId as string,
    restore: 'files',
  });
  expect(r).toEqual({ files: ['hello.txt'] });
  expect(readFileSync(join(ws.root, 'hello.txt'), 'utf8')).toBe('hello world\n');
});
