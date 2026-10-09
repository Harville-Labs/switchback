import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { SwitchbackClient } from '@switchback/client';
import { Engine, SwitchbackConfig, serve } from '@switchback/engine';
import { createTransportPair } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { AcpBridge } from './bridge.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-acp-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * An editor on ACP talking to the bridge, and the bridge to a real engine
 * with a scripted model, all in memory. `answer` picks a permission option.
 */
async function editor(script: Script, answer = (_: acp.RequestPermissionRequest) => 'allow_once') {
  const lp = new ScriptedProvider('lp', 'local', script);
  const engine = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { m: { provider: 'lp', model: 'small', contextWindow: 8_000 } },
      routing: { start: ['m'] },
      permissions: { edit: 'ask' },
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
  });
  const bridge = new AcpBridge({
    version: '9.9.9',
    async connect(cwd) {
      const [server, client] = createTransportPair();
      serve(engine, server);
      const c = new SwitchbackClient(client);
      await c.initialize({ name: 'test', version: '0' }, cwd);
      return c;
    },
  });
  const updates: acp.SessionNotification['update'][] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const connection = acp
    .client({ name: 'test-editor' })
    .onNotification('session/update', ({ params }) => {
      updates.push(params.update);
    })
    .onRequest('session/request_permission', ({ params }) => {
      asked.push(params);
      return { outcome: { outcome: 'selected', optionId: answer(params) } };
    })
    .connect(bridge.app());
  const agent = connection.agent;
  await agent.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION });
  return { agent, updates, asked, lp };
}

const kinds = (updates: acp.SessionNotification['update'][]) => updates.map((u) => u.sessionUpdate);

test('a prompt streams the answer, says which model answered, and ends the turn', async () => {
  const { agent, updates } = await editor([{ text: 'Hello from Switchback.' }]);
  const { sessionId, modes } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  expect(modes?.currentModeId).toBe('default');
  const done = await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'hi' }],
  });
  expect(done.stopReason).toBe('end_turn');
  const said = updates
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => (u.content.type === 'text' ? u.content.text : ''))
    .join('');
  expect(said).toBe('Hello from Switchback.');
  const route = updates.find((u) => u.sessionUpdate === 'agent_thought_chunk');
  expect(route?.content.type === 'text' && route.content.text).toContain('local lp/small');
});

test('an edit asks the editor about the tool call it already showed, and runs when allowed', async () => {
  const { agent, updates, asked } = await editor([
    { toolCalls: [{ name: 'write', input: { path: 'notes.txt', content: 'hi\n' } }] },
    { text: 'done' },
  ]);
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write' }] });

  const call = updates.find((u) => u.sessionUpdate === 'tool_call');
  expect(call).toMatchObject({ title: 'Write notes.txt', kind: 'edit', status: 'in_progress' });
  expect(asked).toHaveLength(1);
  expect(asked[0]?.toolCall.toolCallId).toBe(
    call?.sessionUpdate === 'tool_call' ? call.toolCallId : '',
  );
  expect(asked[0]?.options.map((o) => o.kind)).toContain('reject_once');
  expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('hi\n');
  expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({
    status: 'completed',
  });
});

test('the editor hears why a prompt asks, such as a file outside the workspace', async () => {
  const { agent, asked } = await editor([
    { toolCalls: [{ name: 'read', input: { path: '../elsewhere.txt' } }] },
    { text: 'ok' },
  ]);
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read' }] });
  const content = asked[0]?.toolCall.content?.[0];
  expect(
    content?.type === 'content' && content.content.type === 'text' && content.content.text,
  ).toBe('Asking because: outside the workspace.');
});

test('a denied edit fails its tool call and changes nothing', async () => {
  const { agent, updates } = await editor(
    [
      { toolCalls: [{ name: 'write', input: { path: 'notes.txt', content: 'hi\n' } }] },
      { text: 'ok, I will not' },
    ],
    () => 'reject_once',
  );
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write' }] });
  expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({
    status: 'failed',
  });
  expect(() => readFileSync(join(root, 'notes.txt'))).toThrow();
});

test("the checklist becomes the editor's plan", async () => {
  const { agent, updates } = await editor([
    {
      toolCalls: [
        {
          name: 'todo',
          input: {
            items: [
              { text: 'read', status: 'done' },
              { text: 'fix', status: 'in_progress' },
              { text: 'test', status: 'pending' },
            ],
          },
        },
      ],
    },
    { text: 'on it' },
  ]);
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] });
  expect(updates.find((u) => u.sessionUpdate === 'plan')).toEqual({
    sessionUpdate: 'plan',
    entries: [
      { content: 'read', priority: 'medium', status: 'completed' },
      { content: 'fix', priority: 'medium', status: 'in_progress' },
      { content: 'test', priority: 'medium', status: 'pending' },
    ],
  });
});

test('modes change through the engine, and a loaded session replays its conversation', async () => {
  const { agent, updates } = await editor([{ text: 'first answer' }]);
  const { sessionId } = await agent.request('session/new', { cwd: root, mcpServers: [] });
  await agent.request('session/set_mode', { sessionId, modeId: 'plan' });
  await agent.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'question' }],
  });
  expect(updates).toContainEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
  await expect(agent.request('session/set_mode', { sessionId, modeId: 'yolo' })).rejects.toThrow(
    'unknown mode "yolo"',
  );

  updates.length = 0;
  await agent.request('session/load', { sessionId, cwd: root, mcpServers: [] });
  expect(kinds(updates)).toEqual(['user_message_chunk', 'agent_message_chunk']);
  const listed = await agent.request('session/list', { cwd: root });
  expect(listed.sessions.map((s) => s.sessionId)).toContain(sessionId);
});

test('a prompt for a session this connection never opened is an error that says what to do', async () => {
  const { agent } = await editor([]);
  await expect(
    agent.request('session/prompt', {
      sessionId: 'ses_nope',
      prompt: [{ type: 'text', text: 'x' }],
    }),
  ).rejects.toThrow('session/new');
});
