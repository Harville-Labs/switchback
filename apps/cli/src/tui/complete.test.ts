import { describe, expect, test } from 'bun:test';
import { type Completion, completeArgument, completionSources } from './complete.ts';

const sources = { models: ['fast', 'opus', 'opus-max'], agents: ['build', 'plan'] };
const tab = (input: string, last?: Completion) => completeArgument(input, sources, last)?.value;

describe('Tab in a slash command argument', () => {
  test('one match is completed with a space after it', () => {
    expect(tab('/current fa')).toBe('/current fast ');
    expect(tab('/theme li')).toBe('/theme light ');
    expect(tab('/agent pl')).toBe('/agent plan ');
    expect(tab('/effort xh')).toBe('/effort xhigh ');
  });

  test('several matches complete to their common prefix, then Tab goes round them', () => {
    const first = completeArgument('/current o', sources);
    expect(first?.value).toBe('/current opus');
    const second = completeArgument(first?.value ?? '', sources, first);
    expect(second?.value).toBe('/current opus');
    const third = completeArgument(second?.value ?? '', sources, second);
    expect(third?.value).toBe('/current opus-max');
    expect(completeArgument(third?.value ?? '', sources, third)?.value).toBe('/current opus');
  });

  test('an empty argument goes round every choice', () => {
    const first = completeArgument('/theme ', sources);
    expect(first?.value).toBe('/theme dark');
    expect(completeArgument(first?.value ?? '', sources, first)?.value).toBe('/theme light');
    const prefix = completeArgument('/mouse ', sources);
    expect(prefix?.value).toBe('/mouse o');
    expect(completeArgument(prefix?.value ?? '', sources, prefix)?.value).toBe('/mouse on');
  });

  test('later arguments follow the earlier ones', () => {
    expect(tab('/current fast op')).toBe('/current fast opus');
    expect(tab('/current fast --s')).toBe('/current fast --save ');
    expect(tab('/review with fa')).toBe('/review with fast ');
    expect(tab('/tab new bu')).toBe('/tab new build ');
    expect(tab('/ladder no')).toBe('/ladder none ');
    expect(tab('/ladder fast no')).toBeUndefined();
  });

  test('nothing completes for unknown commands, free text, or no match', () => {
    expect(tab('/rename my')).toBeUndefined();
    expect(tab('/nope x')).toBeUndefined();
    expect(tab('/theme zz')).toBeUndefined();
  });

  test('agents that only run as subagents are not offered', () => {
    const s = completionSources({
      models: [],
      agents: [
        { name: 'build', mode: 'primary' },
        { name: 'explore', mode: 'subagent' },
        { name: 'helper', mode: 'all' },
      ] as Parameters<typeof completionSources>[0]['agents'],
    });
    expect(s.agents).toEqual(['build', 'helper']);
  });
});
