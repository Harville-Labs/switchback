/**
 * Marketplace and walkthrough screenshots, reproducible: the real webview
 * bundle, fed scripted engine events (no model, no VS Code), captured by
 * headless Chrome at 2x in VS Code's Dark Modern colors.
 *
 *   bun apps/vscode/scripts/screenshots.ts        writes apps/vscode/media/screenshots/vscode-*.png
 *
 * Needs Chrome or Chromium: CHROME_PATH, or the usual install locations.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, InitializeResult, SessionSummary } from '@switchback/protocol';
import type { HostToWebview } from '../src/messages.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
// In the extension, so the walkthrough can show them; the READMEs link to them on GitHub.
const OUT = join(ROOT, 'apps', 'vscode', 'media', 'screenshots');

/** VS Code's Dark Modern theme, as the webview's CSS variables. */
const THEME: Record<string, string> = {
  foreground: '#cccccc',
  descriptionForeground: '#9d9d9d',
  focusBorder: '#0078d4',
  'input-background': '#313131',
  'input-border': '#3c3c3c',
  'input-foreground': '#cccccc',
  'input-placeholderForeground': '#989898',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131',
  'button-secondaryForeground': '#cccccc',
  'panel-border': '#2b2b2b',
  'editorWidget-background': '#202020',
  'sideBar-background': '#181818',
  'editor-background': '#1f1f1f',
  'badge-background': '#616161',
  'badge-foreground': '#f8f8f8',
  'textLink-foreground': '#4daafc',
  'widget-shadow': 'rgba(0,0,0,.36)',
  'toolbar-hoverBackground': 'rgba(90,93,94,.31)',
  'charts-yellow': '#cca700',
  'textCodeBlock-background': '#2b2b2b',
  'editor-font-family': 'Menlo, Consolas, monospace',
  'font-family': '-apple-system, "Segoe UI", sans-serif',
};

const session: SessionSummary = {
  id: 's1',
  title: '',
  agent: 'build',
  createdAt: '2026-10-06T00:00:00Z',
  updatedAt: '2026-10-06T00:00:00Z',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  permissionMode: 'default',
};
const local = { provider: 'ollama', model: 'qwen3-coder:30b' };
const remote = { provider: 'anthropic', model: 'claude-sonnet-5' };
const init = {
  protocolVersion: 1,
  engineVersion: '0.7.0',
  workspaceRoot: '/repo',
  models: [
    { alias: 'fast', ref: local, tier: 'local' },
    { alias: 'sonnet', ref: remote, tier: 'remote' },
  ],
  agents: [],
} as unknown as InitializeResult;

const START: HostToWebview[] = [
  { type: 'ready', init, session, route: 'auto' },
  {
    type: 'roles',
    roles: {
      start: ['fast'],
      escalate: [['sonnet']],
      review: { mode: 'auto', models: [] },
      overridden: [],
    },
  },
];

const ev = (event: Partial<EngineEvent>): HostToWebview => ({
  type: 'event',
  event: { sessionId: 's1', turnId: 't1', ...event } as EngineEvent,
});
const tool = (callId: string, name: string, input: object, output: string, isError = false) => [
  ev({ type: 'tool.started', callId, name, input }),
  ev({ type: 'tool.completed', callId, name, output, isError }),
];

interface Scene {
  name: string;
  /** What the user typed (sent as a prompt, so it shows as theirs). */
  prompt: string;
  events: HostToWebview[];
  height: number;
  width?: number;
}

const SCENES: Scene[] = [
  {
    name: 'chat',
    prompt: 'Why do quoted arguments with spaces break the parser?',
    height: 560,
    events: [
      ev({ type: 'turn.started' }),
      ev({
        type: 'route.decided',
        tier: 'local',
        model: local,
        rule: 'default',
        reason: 'the start model',
        step: 0,
        steps: 1,
      }),
      ev({
        type: 'reasoning.delta',
        text: 'The tokenizer probably splits before it looks at quotes.',
      }),
      ...tool('c1', 'read', { path: 'src/args.ts' }, '…'),
      ...tool('c2', 'grep', { pattern: 'split\\(' }, '…'),
      ev({
        type: 'text.delta',
        text: '`tokenize` splits on whitespace **before** it handles quotes, so `"a b"` becomes two tokens:\n\n```ts\nconst words = line.split(/\\s+/); // too early\n```\n\nI\'ll move the quote handling ahead of the split and add a test for quoted and escaped arguments.',
      }),
      ev({
        type: 'call.stats',
        model: local,
        tier: 'local',
        outputTokens: 420,
        tokensPerSecond: 61,
      }),
      ev({
        type: 'usage.updated',
        usage: { inputTokens: 0, outputTokens: 0 },
        costUsd: 0,
        savingsUsd: 0.42,
        tier: 'local',
      }),
      ev({ type: 'turn.completed', stopReason: 'end_turn' }),
    ],
  },
  {
    name: 'escalation',
    prompt: 'Fix the flaky test in sync.test.ts',
    height: 600,
    events: [
      ev({ type: 'turn.started' }),
      ev({
        type: 'route.decided',
        tier: 'local',
        model: local,
        rule: 'default',
        reason: 'the start model',
        step: 0,
        steps: 1,
      }),
      ...tool('c1', 'bash', { command: 'bun test sync' }, '1 fail: expected 3, received 2', true),
      ...tool('c2', 'edit', { path: 'src/sync.ts' }, 'edited'),
      ...tool('c3', 'bash', { command: 'bun test sync' }, '1 fail: expected 3, received 2', true),
      ev({
        type: 'call.stats',
        model: local,
        tier: 'local',
        outputTokens: 300,
        tokensPerSecond: 58,
      }),
      ev({
        type: 'escalation.requested',
        requestId: 'e1',
        reason: 'the same test failed twice after an edit',
        target: remote,
        estimatedCostUsd: 0.04,
      }),
    ],
  },
  {
    name: 'review',
    prompt: 'Retry the upload when the server returns 503',
    height: 600,
    width: 620,
    events: [
      ev({ type: 'turn.started' }),
      ev({
        type: 'route.decided',
        tier: 'local',
        model: local,
        rule: 'default',
        reason: 'the start model',
        step: 0,
        steps: 1,
      }),
      ...tool('c1', 'read', { path: 'src/upload.ts' }, '…'),
      ev({
        type: 'permission.requested',
        requestId: 'p1',
        tool: 'edit',
        summary: 'edit src/upload.ts',
        input: { path: 'src/upload.ts' },
        rules: ['edit(src/upload.ts)'],
        preview: [
          '--- src/upload.ts',
          '+++ src/upload.ts',
          '@@ -12,6 +12,11 @@ export async function upload(file, attempt = 0) {',
          '   const res = await fetch(url, { method: "PUT", body: file });',
          '-  if (!res.ok) throw new Error(`upload: ${res.status}`);',
          '+  if (res.status === 503 && attempt < 3) {',
          '+    await sleep(2 ** attempt * 500);',
          '+    return upload(file, attempt + 1);',
          '+  }',
          '+  if (!res.ok) throw new Error(`upload: ${res.status}`);',
          '   return res.json();',
        ].join('\n'),
      }),
    ],
  },
];

function chrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    Bun.which('google-chrome'),
    Bun.which('chromium'),
    Bun.which('chromium-browser'),
  ];
  const found = candidates.find((c): c is string => !!c && existsSync(c));
  if (!found) throw new Error('Chrome or Chromium is needed: set CHROME_PATH');
  return found;
}

function page(scene: Scene): string {
  const css = Object.entries(THEME)
    .map(([k, v]) => `--vscode-${k}:${v}`)
    .join(';');
  // Type the prompt and send it as the user would, then replay the engine's events.
  // In its own scope: the bundle's top-level names share the page's global scope.
  const play = `{
    const send = (m) => window.postMessage(m, '*');
    ${JSON.stringify(START)}.forEach(send);
    setTimeout(() => {
      const input = document.getElementById('input');
      input.value = ${JSON.stringify(scene.prompt)};
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      ${JSON.stringify(scene.events)}.forEach(send);
      document.getElementById('input').blur();
    }, 100);
  }`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{${css};margin:0;background:#181818;color:#ccc;font:13px -apple-system,"Segoe UI",sans-serif;height:100vh}</style></head>
<body><div id="app"></div><script>window.acquireVsCodeApi=()=>({postMessage(){}});</script><script src="webview.js"></script><script>${play}</script></body></html>`;
}

const dir = mkdtempSync(join(tmpdir(), 'switchback-shots-'));
try {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '..', 'src', 'webview', 'main.ts')],
    target: 'browser',
    outdir: dir,
    naming: 'webview.js',
  });
  if (!built.success) throw new Error(built.logs.join('\n'));
  const browser = chrome();
  for (const scene of SCENES) {
    const html = join(dir, `${scene.name}.html`);
    writeFileSync(html, page(scene));
    const out = join(OUT, `vscode-${scene.name}.png`);
    const proc = Bun.spawn(
      [
        browser,
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        ...(process.env.SHOTS_DEBUG ? ['--enable-logging=stderr', '--v=0'] : []),
        '--force-device-scale-factor=2',
        `--window-size=${scene.width ?? 520},${scene.height}`,
        '--virtual-time-budget=2000',
        `--screenshot=${out}`,
        `file://${html}`,
      ],
      { stdout: 'ignore', stderr: process.env.SHOTS_DEBUG ? 'inherit' : 'ignore' },
    );
    if ((await proc.exited) !== 0 || !existsSync(out))
      throw new Error(`no screenshot for ${scene.name}`);
    console.log(`wrote ${out}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
