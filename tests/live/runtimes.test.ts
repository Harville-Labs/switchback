/**
 * Live runs of the external agent runtimes. Each runs only with
 * SWITCHBACK_LIVE=1 and its own credentials:
 *
 *   claude-agent-sdk       ANTHROPIC_API_KEY and `claude` on PATH
 *   claude-managed-agents  ANTHROPIC_API_KEY, SWITCHBACK_LIVE_MANAGED_AGENT, SWITCHBACK_LIVE_MANAGED_ENVIRONMENT
 *   codex                  OPENAI_API_KEY (or a `codex login`), SWITCHBACK_LIVE_CODEX=1
 *   bedrock-agentcore      AWS credentials and SWITCHBACK_LIVE_AGENTCORE_ARN
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeConfig, type RuntimeEvent } from '@switchback/engine';

const LIVE = process.env.SWITCHBACK_LIVE === '1';
const env = process.env;
const root = mkdtempSync(join(tmpdir(), 'switchback-live-rt-'));
writeFileSync(join(root, 'answer.txt'), 'The answer is 42.\n');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CASES: { name: string; ready: boolean; cfg: RuntimeConfig; local: boolean }[] = [
  {
    name: 'claude-agent-sdk',
    ready: !!env.ANTHROPIC_API_KEY && !!Bun.which('claude'),
    cfg: { type: 'claude-agent-sdk', model: 'claude-haiku-4-5', maxTurns: 5 },
    local: true,
  },
  {
    name: 'claude-managed-agents',
    ready:
      !!env.ANTHROPIC_API_KEY &&
      !!env.SWITCHBACK_LIVE_MANAGED_AGENT &&
      !!env.SWITCHBACK_LIVE_MANAGED_ENVIRONMENT,
    cfg: {
      type: 'claude-managed-agents',
      agent: env.SWITCHBACK_LIVE_MANAGED_AGENT ?? '',
      environment: env.SWITCHBACK_LIVE_MANAGED_ENVIRONMENT ?? '',
    },
    local: false,
  },
  {
    name: 'codex',
    ready: env.SWITCHBACK_LIVE_CODEX === '1',
    cfg: { type: 'codex', sandbox: 'read-only', network: false },
    local: true,
  },
  {
    name: 'bedrock-agentcore',
    ready: !!env.SWITCHBACK_LIVE_AGENTCORE_ARN,
    cfg: { type: 'bedrock-agentcore', arn: env.SWITCHBACK_LIVE_AGENTCORE_ARN ?? 'arn:' },
    local: false,
  },
];

describe.if(LIVE)('external runtimes', () => {
  for (const c of CASES) {
    test.if(c.ready)(
      c.name,
      async () => {
        const events: RuntimeEvent[] = [];
        // Local runtimes read the file; hosted ones just answer.
        const prompt = c.local
          ? 'Read answer.txt and reply with only the number in it.'
          : 'Reply with only the number 42.';
        const r = await createRuntime(c.name, c.cfg).run({
          prompt,
          cwd: root,
          signal: AbortSignal.timeout(240_000),
          canUseTool: async () => ({ allowed: true }),
          onEvent: (e) => events.push(e),
        });
        expect(r.ok).toBe(true);
        expect(r.text).toContain('42');
        expect(events.length).toBeGreaterThan(0);
      },
      300_000,
    );
  }
});
