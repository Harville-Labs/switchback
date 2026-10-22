/**
 * Tab completion for a slash command's arguments, where they come from a
 * known list: model aliases, agents, themes, and the fixed words commands
 * take. Pure, so the prompt only keeps the last completion between presses.
 */
import { EffortLevel, type InitializeResult } from '@switchback/protocol';
import { THEME_NAMES } from './theme.ts';

/** What arguments can name, as the app knows it now. */
export interface CompletionSources {
  models: readonly string[];
  /** Agents that run sessions (not subagent-only ones). */
  agents: readonly string[];
}

const fixed =
  (...words: string[]) =>
  (before: readonly string[]) =>
    before.length ? [] : words;

/** Role commands take any number of models, and `--save`. */
const rolesArgs = (before: readonly string[], s: CompletionSources) => [
  ...s.models.filter((m) => !before.includes(m)),
  '--save',
];

const ladderArgs = (before: readonly string[], s: CompletionSources) =>
  before.length ? rolesArgs(before, s) : ['none', ...rolesArgs(before, s)];

const CHOICES: Record<
  string,
  (before: readonly string[], s: CompletionSources) => readonly string[]
> = {
  current: rolesArgs,
  start: rolesArgs,
  model: rolesArgs,
  ladder: ladderArgs,
  escalate: ladderArgs,
  'subagent-model': (before, s) => (before.length ? ['--save'] : [...s.models, 'none']),
  review: (before, s) => {
    if (!before.length) return ['on', 'off', 'default', 'ladder', 'with'];
    if (before[0] === 'with') return rolesArgs(before.slice(1), s);
    return before[0] === 'ladder' ? ['--save'] : [];
  },
  agent: (before, s) => (before.length ? [] : s.agents),
  tab: (before, s) => {
    if (!before.length) return ['new', 'close'];
    return before.length === 1 && before[0] === 'new' ? s.agents : [];
  },
  effort: fixed(...EffortLevel.options, 'default'),
  usage: fixed('rule', 'agent', 'model'),
  theme: fixed(...THEME_NAMES),
  mouse: fixed('on', 'off'),
  autocompact: (before) =>
    before.some((a) => a !== '--save') ? ['--save'] : ['on', 'off', '--save'],
  models: fixed('refresh'),
  roles: fixed('reset'),
  shells: fixed('kill'),
  copy: fixed('tool', 'all'),
  goal: fixed('stop'),
};

/** Completion sources from what the engine said at startup. */
export function completionSources(
  init: Pick<InitializeResult, 'models' | 'agents'>,
): CompletionSources {
  return {
    models: init.models.map((m) => m.alias),
    agents: init.agents.filter((a) => a.mode !== 'subagent').map((a) => a.name),
  };
}

/** A completed argument, kept so the next Tab can go on to the next match. */
export interface Completion {
  /** The input after this completion. */
  value: string;
  /** Every choice that starts with what was typed. */
  matches: readonly string[];
  /** The match in `value`, or -1 while it holds only their common prefix. */
  index: number;
  /** The input before the word being completed. */
  base: string;
}

function commonPrefix(words: readonly string[]): string {
  return words.reduce((p, w) => {
    let i = 0;
    while (i < p.length && p[i] === w[i]) i++;
    return p.slice(0, i);
  });
}

/**
 * Tab in `/command args`: complete the last word from the command's choices.
 * One match is completed with a space after it; several are completed to
 * their common prefix, and when that adds nothing, Tab goes round them.
 * Undefined when the command takes no known values or nothing matches.
 */
export function completeArgument(
  input: string,
  sources: CompletionSources,
  last?: Completion,
): Completion | undefined {
  if (last && last.value === input && last.matches.length > 1) {
    const index = (last.index + 1) % last.matches.length;
    return { ...last, index, value: last.base + last.matches[index] };
  }
  const m = /^\/(\S+)\s+(.*)$/s.exec(input);
  if (!m?.[1]) return undefined;
  const words = (m[2] ?? '').split(/\s+/);
  const word = words.pop() ?? '';
  const base = input.slice(0, input.length - word.length);
  const choices = CHOICES[m[1]]?.(words.filter(Boolean), sources) ?? [];
  const matches = choices.filter((c) => c.toLowerCase().startsWith(word.toLowerCase()));
  const [only] = matches;
  if (only === undefined) return undefined;
  if (matches.length === 1) return { value: `${base}${only} `, matches, index: 0, base };
  const prefix = commonPrefix(matches);
  if (prefix.length > word.length) return { value: base + prefix, matches, index: -1, base };
  return { value: base + only, matches, index: 0, base };
}
