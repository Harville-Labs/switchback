import { describe, expect, test } from 'bun:test';
import type { Message } from '@harness/protocol';
import { countTokens, messageTokens, nearThreshold, promptText, promptTokens } from './tokens.ts';

describe('token counting', () => {
  test('counts code far more accurately than chars/4', () => {
    const code = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
    const n = countTokens(code);
    expect(n).toBeGreaterThan(15);
    expect(n).toBeLessThan(30);
  });

  test('pathological input without whitespace stays fast', () => {
    const started = performance.now();
    const n = countTokens('x'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(n).toBeGreaterThan(10_000);
  });

  test('chunking changes counts negligibly on normal text', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
    const whole = countTokens(text.slice(0, 2_000)) * (text.length / 2_000);
    expect(Math.abs(countTokens(text) - whole) / whole).toBeLessThan(0.02);
  });

  test('prompt count covers system, tools, and every part type; cached per message', () => {
    const messages: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: 'read a.ts' }] },
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'c', name: 'read', input: { path: 'a.ts' } }],
      },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'c', content: 'const a = 1;' }] },
    ];
    const n = promptTokens('system prompt', messages, '[{"name":"read"}]');
    expect(n).toBeGreaterThan(20);
    expect(promptTokens('system prompt', messages, '[{"name":"read"}]')).toBe(n);
    expect(messageTokens(messages[0] as Message)).toBeGreaterThan(4);
    expect(promptText('s', messages, 't')).toContain('const a = 1;');
  });

  test('near-threshold window', () => {
    expect(nearThreshold(6_500, 7_000)).toBe(true);
    expect(nearThreshold(8_000, 7_000)).toBe(true);
    expect(nearThreshold(3_000, 7_000)).toBe(false);
    expect(nearThreshold(20_000, 7_000)).toBe(false);
  });
});
