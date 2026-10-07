/**
 * Regenerates the TUI screenshots in docs/assets/screenshots/ for the README.
 *
 *   bun run screenshots
 *
 * It runs the real engine and the real TUI against a small demo project, with
 * the model replaced by a script (`turns` below), so the shots come out the
 * same every time and need no model server. The tools really run: the read,
 * the search, the edit, and `bun test` all happen in a temporary directory.
 * The terminal output goes into @xterm/headless and comes out as SVG.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { SwitchbackClient } from '@switchback/client';
import { engineFromWorkspace, loadConfig, serve } from '@switchback/engine';
import { createTransportPair } from '@switchback/protocol';
import { ScriptedProvider, type ScriptedTurn } from '@switchback/providers';
import { Terminal } from '@xterm/headless';
import pkg from '../package.json' with { type: 'json' };
import { terminalSvg } from './terminal-svg.ts';

const COLS = 100;
const ROWS = 48;
const OUT = resolve(import.meta.dir, '../../../docs/assets/screenshots');

/** The demo project: a retry helper whose backoff grows linearly. */
const PROJECT: Record<string, string> = {
  'package.json': '{ "name": "shop", "private": true, "type": "module" }\n',
  'src/http/backoff.ts': `/** How long to wait before retry number \`attempt\` (1-based), in milliseconds. */
export function backoff(attempt: number): number {
  const base = 250;
  return base * attempt;
}
`,
  'src/http/client.ts': `import { backoff } from './backoff.ts';

const RETRYABLE = new Set([429, 502, 503, 504]);

/** Fetches \`url\`, retrying rate limits and gateway errors up to \`retries\` times. */
export async function request(url: string, retries = 4): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (!RETRYABLE.has(res.status) || attempt > retries) return res;
    await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
  }
}
`,
  'src/http/backoff.test.ts': `import { expect, test } from 'bun:test';
import { backoff } from './backoff.ts';

test('doubles the base delay with up to 125 ms of jitter', () => {
  for (const [attempt, base] of [[1, 250], [2, 500], [3, 1000], [4, 2000]]) {
    expect(backoff(attempt)).toBeGreaterThanOrEqual(base);
    expect(backoff(attempt)).toBeLessThan(base + 125);
  }
});

test('never waits more than 30 seconds', () => {
  expect(backoff(20)).toBe(30_000);
});
`,
};

const PROMPT =
  'The retry backoff in src/http/backoff.ts grows linearly. Make it exponential with jitter, capped at 30 seconds, then run the tests.';

/** What the scripted model says and does, one entry per model call. */
const turns: ScriptedTurn[] = [
  {
    reasoning:
      'The user wants exponential backoff with jitter and a 30 second cap. Before changing anything I should read the current implementation and see who calls it, so the new curve still fits how retries are counted.',
    toolCalls: [
      { name: 'read', input: { path: 'src/http/backoff.ts' } },
      { name: 'grep', input: { pattern: 'backoff\\(', path: 'src' } },
    ],
  },
  {
    reasoning:
      'Attempts are 1-based and the client sleeps backoff(attempt) between tries. Doubling from 250 ms gives 250, 500, 1000, ... Jitter of up to half the base stays within the test ranges, and Math.min applies the cap.',
    toolCalls: [
      {
        name: 'edit',
        input: {
          path: 'src/http/backoff.ts',
          oldString: '  const base = 250;\n  return base * attempt;',
          newString:
            '  const base = 250;\n  const cap = 30_000;\n  const jitter = Math.random() * (base / 2);\n  return Math.min(cap, base * 2 ** (attempt - 1) + jitter);',
        },
      },
    ],
  },
  { toolCalls: [{ name: 'bash', input: { command: 'bun test src/http' } }] },
  {
    text: "Backoff is exponential now: 250 ms, 500 ms, 1 s, 2 s, and so on, plus up to 125 ms of jitter so clients that failed together don't retry together. It never waits more than 30 seconds. Both tests in `src/http/backoff.test.ts` pass.",
  },
];

/** A terminal for Ink: what it writes goes into the headless terminal. */
function fakeTerminal(term: Terminal) {
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        term.write(chunk, () => done());
      },
    }),
    { isTTY: true, columns: COLS, rows: ROWS },
  ) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  }) as unknown as NodeJS.ReadStream;
  return { stdout, stdin };
}

function screenText(term: Terminal): string {
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++)
    lines.push(
      term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString() ?? '',
    );
  return lines.join('\n');
}

async function waitFor(term: Terminal, test: (screen: string) => boolean, what: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (test(screenText(term).replace(/\s+/g, ' '))) return;
    await Bun.sleep(100);
  }
  throw new Error(
    `screenshots: timed out waiting for ${what}. The screen was:\n${screenText(term)}`,
  );
}

async function main() {
  const root = mkdtempSync(join(homedir(), '.switchback-screenshots-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  process.env.SWITCHBACK_HOME = join(root, '.switchback');
  process.env.FORCE_COLOR = '3';
  delete process.env.CI; // Ink draws only the last frame in CI
  const cwd = join(root, 'code', 'shop');
  for (const [path, content] of Object.entries(PROJECT)) {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  mkdirSync(process.env.SWITCHBACK_HOME, { recursive: true });
  writeFileSync(
    join(process.env.SWITCHBACK_HOME, 'config.json'),
    JSON.stringify({
      providers: {
        local: { type: 'mock', tier: 'local' },
        cloud: { type: 'mock', tier: 'remote' },
      },
      models: {
        'qwen3-coder': { provider: 'local', model: 'qwen3-coder', contextWindow: 65_536 },
        'claude-opus-5': { provider: 'cloud', model: 'claude-opus-5', contextWindow: 200_000 },
      },
      routing: { start: ['qwen3-coder'], escalate: [['claude-opus-5']] },
      permissions: { allow: ['bash(bun test:*)'] },
    }),
  );

  // Ink and the TUI load after the environment above is in place.
  const { render } = await import('ink');
  const { App } = await import('../src/tui/App.tsx');
  const { mouseInput } = await import('../src/tui/mouse.ts');

  const loaded = loadConfig(cwd, process.env);
  const providers = new Map([
    ['local', new ScriptedProvider('local', 'local', turns)],
    ['cloud', new ScriptedProvider('cloud', 'remote', [])],
  ]);
  const { engine } = engineFromWorkspace(cwd, loaded.config, {
    prices: loaded.prices,
    interaction: 'prompt',
    providers,
  });
  const [serverSide, clientSide] = createTransportPair();
  serve(engine, serverSide);
  const client = new SwitchbackClient(clientSide);
  const init = await client.initialize({ name: 'screenshots', version: pkg.version }, cwd);
  const session = await client.request('session.create', {});

  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, convertEol: true });
  const { stdout, stdin } = fakeTerminal(term);
  const mouse = mouseInput(stdin, stdout);
  const app = render(
    <App
      client={client}
      init={{ ...init, workspaceRoot: join(homedir(), 'code', 'shop') }}
      initialSession={session}
      initialRoute="auto"
      warnings={[]}
      initialTheme="dark"
      mouse={mouse}
    />,
    { stdout, stdin: mouse.stdin, exitOnCtrlC: false, alternateScreen: true, patchConsole: false },
  );
  const press = async (keys: string) => {
    stdin.write(keys);
    await Bun.sleep(150);
  };
  const shoot = (name: string, title: string) => {
    writeFileSync(join(OUT, `${name}.svg`), terminalSvg(term, title));
    console.log(`wrote docs/assets/screenshots/${name}.svg`);
  };

  mkdirSync(OUT, { recursive: true });
  await waitFor(term, (s) => s.includes('Ask anything'), 'the prompt');
  for (const ch of PROMPT) stdin.write(ch);
  await Bun.sleep(300);
  await press('\r');

  await waitFor(
    term,
    (s) => s.includes('tell it what to do instead'),
    'the edit permission prompt',
  );
  await Bun.sleep(300);
  shoot('permission-diff', 'Switchback asks before an edit and shows it as a diff');
  await press('1');

  await waitFor(
    term,
    (s) => s.includes('Both tests') && !s.includes('esc to interrupt'),
    'the end of the turn',
  );
  await Bun.sleep(500);
  shoot('turn', 'A Switchback turn: thinking, exploring the code, an edit, and the tests');
  await press('\x0f'); // ctrl+o: expand thinking, diffs, and command output
  await Bun.sleep(500);
  shoot('turn-expanded', 'The same turn with the thinking and the test output expanded');

  app.unmount();
  mouse.dispose();
  await client.request('shutdown', {}).catch(() => {});
  process.exit(0);
}

await main();
