/**
 * Getting the user's attention from a terminal: a desktop notification
 * through the escape sequence the terminal understands, or the bell.
 * Terminals ignore sequences they don't know, so one that might not show
 * anything gets the bell instead.
 */
import type { NotificationSettings } from '@switchback/protocol';

const BEL = '\x07';
const ST = '\x1b\\';

type Env = Record<string, string | undefined>;

/** What to write to the terminal for a notification, or '' for none. */
export function terminalNotification(
  message: string,
  mode: NotificationSettings['mode'],
  env: Env = process.env,
): string {
  if (mode === 'off') return '';
  if (mode === 'bell') return BEL;
  const text = clean(message);
  // tmux swallows these unless passthrough is on; it does surface the bell.
  if (env.TMUX) return BEL;
  switch (protocolOf(env)) {
    case 'osc9':
      return `\x1b]9;${text}${BEL}`;
    case 'osc99':
      return `\x1b]99;;${text}${ST}`;
    case 'osc777':
      return `\x1b]777;notify;Switchback;${text}${BEL}`;
    default:
      return BEL;
  }
}

/** Which notification sequence the terminal is known to show. */
function protocolOf(env: Env): 'osc9' | 'osc99' | 'osc777' | undefined {
  const program = env.TERM_PROGRAM ?? '';
  const term = env.TERM ?? '';
  if (['iTerm.app', 'WezTerm', 'ghostty'].includes(program)) return 'osc9';
  if (env.KITTY_WINDOW_ID || term === 'xterm-kitty') return 'osc99';
  if (term.startsWith('foot') || term.startsWith('rxvt')) return 'osc777';
  return undefined;
}

/** One line of printable text: control characters would end the sequence early. */
function clean(message: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  return message.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
}
