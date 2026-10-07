import { describe, expect, test } from 'bun:test';
import type { PendingPermission, ViewItem } from '@switchback/client';
import { render } from 'ink-testing-library';
import { diffLines } from './Diff.tsx';
import { takeWheel } from './mouse.ts';
import { type PermissionAnswer, PermissionPrompt } from './Prompts.tsx';
import { quietRoutes } from './Rows.tsx';
import { visibleLines } from './Transcript.tsx';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('mouse wheel', () => {
  test('wheel events come out of the input; keys and clicks never reach the prompt as text', () => {
    expect(takeWheel('a\x1b[<64;10;5Mb\x1b[<65;1;1M')).toEqual({ rest: 'ab', deltas: [-3, 3] });
    // Shift+wheel (64 + 4) still scrolls; a click is dropped without moving anything.
    expect(takeWheel('\x1b[<68;1;1M\x1b[<0;3;4M\x1b[<0;3;4m')).toEqual({ rest: '', deltas: [-3] });
    expect(takeWheel('\x1b[A')).toEqual({ rest: '\x1b[A', deltas: [] });
  });
});

describe('diffs', () => {
  test('number lines from the hunk: new numbers for added and kept lines, old ones for removed', () => {
    const lines = diffLines(
      '--- a/x\n+++ b/x\n@@ -3,3 +3,3 @@\n keep\n-old\n+new\n@@ -20,1 +20,1 @@\n-z\n+y',
    );
    expect(lines.map((l) => [l.kind, l.number ?? null])).toEqual([
      ['context', 3],
      ['remove', 4],
      ['add', 4],
      ['gap', null],
      ['remove', 20],
      ['add', 20],
    ]);
  });
});

describe('the viewport', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  test('follows the end, and scrolls back by lines', () => {
    expect(visibleLines(lines, 3, 0)).toEqual(['line 7', 'line 8', 'line 9']);
    expect(visibleLines(lines, 3, 2)).toEqual(['line 5', 'line 6', 'line 7']);
    expect(visibleLines(lines, 20, 0)).toHaveLength(10);
  });

  test('route rows show only when the model changes', () => {
    const route = (id: string, model: string, rule: string): ViewItem => ({
      kind: 'route',
      id,
      tier: 'local',
      model: { provider: 'p', model },
      rule,
      reason: '',
    });
    const quiet = quietRoutes([
      route('r1', 'small', 'default'),
      route('r2', 'small', 'sticky'),
      route('r3', 'big', 'escalation'),
      route('r4', 'big', 'sticky'),
    ]);
    expect([...quiet]).toEqual(['r1', 'r2', 'r4']);
  });
});

describe('permission prompt', () => {
  const p: PendingPermission = {
    requestId: 'perm_1',
    sessionId: 's',
    tool: 'bash',
    summary: '$ make deploy',
    rules: ['bash(make deploy:*)'],
  };

  function prompt() {
    const answers: PermissionAnswer[] = [];
    const ui = render(
      <PermissionPrompt
        permission={p}
        maxLines={10}
        width={80}
        onAnswer={(a) => answers.push(a)}
      />,
    );
    return { ui, answers };
  }

  test('lists the choices; arrows and Enter pick one', async () => {
    const { ui, answers } = prompt();
    expect(ui.lastFrame()).toContain("Yes, and don't ask again this session");
    ui.stdin.write('\x1b[B');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual([{ decision: 'allow_always' }]);
  });

  test('numbers and the old letters answer too', async () => {
    const a = prompt();
    a.ui.stdin.write('3');
    await tick();
    expect(a.answers).toEqual([{ decision: 'allow_always', save: 'project' }]);
    const b = prompt();
    b.ui.stdin.write('n');
    await tick();
    expect(b.answers).toEqual([{ decision: 'deny' }]);
  });

  test('"tell it what to do instead" sends a note with the refusal', async () => {
    const { ui, answers } = prompt();
    ui.stdin.write('5');
    await tick();
    for (const ch of 'run tests first') ui.stdin.write(ch);
    await tick();
    expect(ui.lastFrame()).toContain('run tests first');
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual([{ decision: 'deny', feedback: 'run tests first' }]);
  });

  test('a note pasted with its Enter arrives whole', async () => {
    const { ui, answers } = prompt();
    ui.stdin.write('5');
    await tick();
    ui.stdin.write('use staging');
    ui.stdin.write('\r');
    await tick();
    expect(answers).toEqual([{ decision: 'deny', feedback: 'use staging' }]);
  });
});
