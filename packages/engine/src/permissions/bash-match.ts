/**
 * Matching shell commands against `bash(...)` rules.
 *
 * A command line can hold several commands (`a && b; c | d`). Deny and ask
 * rules match when any of them matches; allow rules only when every one does,
 * so `bash(git status:*)` never approves `git status; rm -rf x`. Commands
 * whose text can run more than it shows (command substitution, backticks,
 * process substitution, output redirection) are never approved by a rule.
 *
 * This is a policy aid, not a sandbox: a script can do anything its
 * interpreter can. OS sandboxing of the bash tool is separate.
 */
import { parse } from 'shell-quote';

/** Operators that end one command and start the next. */
const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);
/** Redirections that write to a file. */
const WRITES = new Set(['>', '>>', '>|', '&>', '&>>']);

export interface ParsedCommand {
  /** Each simple command, words joined by single spaces, quotes removed. */
  commands: string[];
  /**
   * The same commands as deny and ask rules see them: without leading
   * `VAR=value` assignments or wrappers (`sudo`, `env`, `xargs`, ...), so
   * `sudo rm -rf x` still matches `bash(rm:*)`.
   */
  bare: string[];
  /** Something no rule can vouch for: substitution or a write redirection. */
  opaque: boolean;
}

export function parseCommand(line: string): ParsedCommand {
  // shell-quote drops quoting, so "$(...)" inside double quotes would look
  // like plain text; check the raw line.
  let opaque = /\$\(|`|<\(|>\(/.test(line);
  const commands: string[] = [];
  // shell-quote reads a newline as a space; each line is its own command.
  for (const text of line.split(/\r?\n/)) {
    let words: string[] = [];
    const flush = () => {
      if (words.length) commands.push(words.join(' '));
      words = [];
    };
    const tokens = parse(text, (name) => `$${name}`);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === undefined) continue;
      if (typeof t === 'string') words.push(t);
      else if ('op' in t && t.op === 'glob') words.push(t.pattern);
      else if ('op' in t && SEPARATORS.has(t.op)) flush();
      else if ('op' in t) {
        // `2>&1` duplicates a descriptor; `> /dev/null` discards. Anything else writes a file.
        const next = tokens[i + 1];
        const target = typeof next === 'string' ? next : '';
        if (WRITES.has(t.op) && target !== '/dev/null') opaque = true;
        if (t.op === '>&' && !/^\d+$/.test(target)) opaque = true;
        i++; // the redirection's target is not a word of the command
      } else if ('comment' in t) break;
    }
    flush();
  }
  return { commands, bare: commands.map(unwrap), opaque };
}

/** Commands that run the rest of their arguments as another command. */
const WRAPPERS = new Set([
  'sudo',
  'env',
  'nohup',
  'nice',
  'time',
  'command',
  'exec',
  'xargs',
  'doas',
]);

function unwrap(command: string): string {
  const words = command.split(' ');
  let i = 0;
  for (;;) {
    const w = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
    else if (WRAPPERS.has(w)) {
      i++;
      while ((words[i] ?? '').startsWith('-')) i++;
    } else break;
  }
  return words.slice(i).join(' ');
}

/**
 * One command against a specifier: `git status` (exactly), `npm run test:*`
 * (that, or that followed by arguments), or a pattern with `*` wildcards.
 */
export function commandMatches(command: string, specifier: string): boolean {
  const spec = normalize(specifier);
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trimEnd();
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (spec.includes('*')) {
    const re = new RegExp(`^${spec.split('*').map(escapeRegex).join('.*')}$`, 's');
    return re.test(command);
  }
  return command === spec;
}

/** A specifier read the way commands are: words separated by single spaces, quotes removed. */
function normalize(specifier: string): string {
  if (specifier.endsWith(':*')) return `${normalize(specifier.slice(0, -2))}:*`;
  return specifier
    .split('*')
    .map((part) =>
      parse(part)
        .map((t) => (typeof t === 'string' ? t : 'op' in t ? t.op : ''))
        .join(' '),
    )
    .join('*');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tools whose second word is the real command (`git status`, `npm run`). */
const TWO_WORD = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'bunx',
  'npx',
  'cargo',
  'go',
  'docker',
  'kubectl',
  'gh',
  'uv',
  'pip',
  'poetry',
  'dotnet',
  'make',
  'just',
]);

/**
 * The rules "always allow" adds for a command: one prefix rule per command,
 * like `bash(git status:*)`, or the exact line when it can't be split safely.
 */
export function suggestBashRules(line: string): string[] {
  const parsed = parseCommand(line);
  if (parsed.opaque || !parsed.commands.length) return [`bash(${line})`];
  const rules = parsed.commands.map((c) => {
    const words = c.split(' ');
    const head = words.slice(0, TWO_WORD.has(words[0] ?? '') && words.length > 1 ? 2 : 1);
    return `bash(${head.join(' ')}:*)`;
  });
  return [...new Set(rules)];
}
