/**
 * What the permission rules say about one tool call. Deny beats ask beats
 * allow, whichever layer each rule came from; a call no rule mentions falls
 * through to the permission mode and the category's level (tool-runner.ts).
 */
import type { SwitchbackConfig } from '../config.ts';
import type { PermissionCategory } from '../tools/tool.ts';
import { commandMatches, parseCommand, suggestBashRules } from './bash-match.ts';
import { pathMatcher, toolPaths } from './path-match.ts';
import { type PermissionRule, parseRule, type RuleBehavior } from './rules.ts';

export interface SourcedRule {
  rule: string;
  behavior: RuleBehavior;
  /** Where it came from: a config file, `organization`, or `this session`. */
  source: string;
}

export interface ToolCall {
  name: string;
  category: PermissionCategory;
  input: unknown;
}

export interface RuleVerdict {
  behavior: RuleBehavior;
  /** The deciding rule; for an allow that took several (`a && b`), the first. */
  rule: SourcedRule;
}

interface Compiled extends SourcedRule {
  parsed: PermissionRule;
}

export class PermissionPolicy {
  private readonly rules: Compiled[];

  constructor(
    rules: SourcedRule[],
    private readonly home?: string,
  ) {
    this.rules = rules.map((r) => ({ ...r, parsed: parseRule(r.rule) }));
  }

  evaluate(call: ToolCall, root: string): RuleVerdict | undefined {
    const applies = this.rules.filter((r) => targets(r.parsed, call));
    const of = (b: RuleBehavior) => applies.filter((r) => r.behavior === b);
    if (call.category === 'bash') return this.evaluateBash(call, of);
    const hit = (b: RuleBehavior) => of(b).find((r) => this.matches(r.parsed, call, root));
    const found = hit('deny') ?? hit('ask') ?? hit('allow');
    return found ? { behavior: found.behavior, rule: found } : undefined;
  }

  /** Whether deny rules keep a file out of reads, so search results leave it out too. */
  hides(absolutePath: string, root: string): boolean {
    return this.rules.some(
      (r) =>
        r.behavior === 'deny' &&
        r.parsed.target.kind === 'read' &&
        (!r.parsed.specifier || pathMatcher(r.parsed.specifier, root, this.home)(absolutePath)),
    );
  }

  /** The rules for listings, deny first. */
  list(): SourcedRule[] {
    const order = { deny: 0, ask: 1, allow: 2 };
    return [...this.rules]
      .sort((a, b) => order[a.behavior] - order[b.behavior])
      .map(({ rule, behavior, source }) => ({ rule, behavior, source }));
  }

  private evaluateBash(
    call: ToolCall,
    of: (b: RuleBehavior) => Compiled[],
  ): RuleVerdict | undefined {
    const line = (call.input as { command?: unknown } | undefined)?.command;
    if (typeof line !== 'string') return undefined;
    const parsed = parseCommand(line);
    // Deny and ask look through wrappers and assignments; allow takes commands as written.
    const any = (r: Compiled) =>
      !r.parsed.specifier ||
      [...parsed.commands, ...parsed.bare].some((c) =>
        commandMatches(c, r.parsed.specifier as string),
      );
    const deny = of('deny').find(any);
    if (deny) return { behavior: 'deny', rule: deny };
    const ask = of('ask').find(any);
    if (ask) return { behavior: 'ask', rule: ask };
    const allows = of('allow');
    // A rule with no specifier allows bash outright, even what can't be parsed.
    const blanket = allows.find((r) => !r.parsed.specifier);
    if (blanket) return { behavior: 'allow', rule: blanket };
    if (parsed.opaque || !parsed.commands.length) return undefined;
    const covering = parsed.commands.map((c) =>
      allows.find((r) => commandMatches(c, r.parsed.specifier as string)),
    );
    const first = covering[0];
    return first && covering.every(Boolean) ? { behavior: 'allow', rule: first } : undefined;
  }

  private matches(rule: PermissionRule, call: ToolCall, root: string): boolean {
    if (!rule.specifier) return true;
    if (rule.target.kind === 'webfetch') return domainMatches(rule.specifier, call.input);
    if (rule.target.kind !== 'read' && rule.target.kind !== 'edit') return false;
    const matches = pathMatcher(rule.specifier, root, this.home);
    return toolPaths(root, pathInput(call), this.home).some(matches);
  }
}

/** Whether a rule is about this tool at all. */
function targets(rule: PermissionRule, call: ToolCall): boolean {
  const t = rule.target;
  if (t.kind === 'mcp') {
    const [, server, tool] = call.name.split('__');
    return call.category === 'mcp' && server === t.server && (!t.tool || tool === t.tool);
  }
  if (t.kind === 'webfetch' || t.kind === 'websearch') return t.kind === call.name;
  return t.kind === call.category;
}

/** `domain:example.com` (or `domain:*.example.com`) against a fetch's URL. */
function domainMatches(specifier: string, input: unknown): boolean {
  const m = /^domain:(.+)$/.exec(specifier.trim());
  const url = (input as { url?: unknown } | undefined)?.url;
  if (!m?.[1] || typeof url !== 'string') return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = m[1].toLowerCase();
  if (domain.startsWith('*.')) return host.endsWith(domain.slice(1)) || host === domain.slice(2);
  return host === domain;
}

/** The path a file tool acts on; search tools default to the root. */
function pathInput(call: ToolCall): string {
  const i = (call.input ?? {}) as { path?: unknown; file_path?: unknown };
  const path = i.path ?? i.file_path;
  return typeof path === 'string' ? path : '.';
}

/** A config's rules when nobody recorded where they came from (an engine built from a config object). */
export function configRules(config: SwitchbackConfig): SourcedRule[] {
  const { allow, ask, deny } = config.permissions;
  return [
    ...deny.map((rule) => ({ rule, behavior: 'deny' as const, source: 'config' })),
    ...ask.map((rule) => ({ rule, behavior: 'ask' as const, source: 'config' })),
    ...allow.map((rule) => ({ rule, behavior: 'allow' as const, source: 'config' })),
  ];
}

/** What "always allow" grants for a call, as rules the user can read and later edit. */
export function suggestRules(call: ToolCall): string[] {
  switch (call.category) {
    case 'bash': {
      const command = (call.input as { command?: unknown } | undefined)?.command;
      return typeof command === 'string' ? suggestBashRules(command) : ['bash'];
    }
    case 'mcp':
      return [call.name.split('__').slice(0, 2).join('__')];
    case 'read':
    case 'edit':
      return [call.category];
    case 'web': {
      const url = (call.input as { url?: unknown } | undefined)?.url;
      if (call.name !== 'webfetch' || typeof url !== 'string') return [call.name];
      try {
        return [`webfetch(domain:${new URL(url).hostname})`];
      } catch {
        return [];
      }
    }
    case 'none':
      return [];
  }
}
