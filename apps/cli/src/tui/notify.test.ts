import { expect, test } from 'bun:test';
import { terminalNotification } from './notify.ts';

test('each terminal gets the notification it shows, and the rest the bell', () => {
  const msg = 'Switchback needs your permission';
  expect(terminalNotification(msg, 'system', { TERM_PROGRAM: 'iTerm.app' })).toBe(
    `\x1b]9;${msg}\x07`,
  );
  expect(terminalNotification(msg, 'system', { TERM: 'xterm-kitty' })).toBe(
    `\x1b]99;;${msg}\x1b\\`,
  );
  expect(terminalNotification(msg, 'system', { TERM: 'foot' })).toBe(
    `\x1b]777;notify;Switchback;${msg}\x07`,
  );
  expect(terminalNotification(msg, 'system', { TERM_PROGRAM: 'Apple_Terminal' })).toBe('\x07');
  expect(terminalNotification(msg, 'system', { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/t' })).toBe(
    '\x07',
  );
  expect(terminalNotification(msg, 'bell', { TERM_PROGRAM: 'ghostty' })).toBe('\x07');
  expect(terminalNotification(msg, 'off', { TERM_PROGRAM: 'ghostty' })).toBe('');
});

test('control characters in the message cannot end the sequence early', () => {
  expect(
    terminalNotification('run `x\x07\x1b]0;evil`', 'system', { TERM_PROGRAM: 'WezTerm' }),
  ).toBe('\x1b]9;run `x ]0;evil`\x07');
});
