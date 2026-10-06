/**
 * Permission rules in Claude Code's syntax: a tool, optionally with a
 * specifier in parentheses. `bash(npm run test:*)`, `read(**\/.env)`,
 * `edit(src/**)`, `mcp__github`, `mcp__github__create_issue`.
 *
 * File tools are grouped as Claude Code groups them: a `read` rule covers
 * read, glob, and grep; an `edit` rule covers edit and write.
 */

export type RuleBehavior = 'allow' | 'ask' | 'deny';

export type RuleTarget =
  | { kind: 'bash' }
  | { kind: 'read' }
  | { kind: 'edit' }
  /** `domain:<host>` specifiers; `*.example.com` covers subdomains. */
  | { kind: 'webfetch' }
  | { kind: 'websearch' }
  /** `tool` undefined or `*`: every tool of the server. */
  | { kind: 'mcp'; server: string; tool?: string };

export interface PermissionRule {
  /** As written, for messages and listings. */
  text: string;
  target: RuleTarget;
  /** The part in parentheses; undefined matches every call of the tool. */
  specifier?: string;
}

/** Claude Code's tool names, so rules copied from `.claude/settings.json` work unchanged. */
const NAMES: Record<string, Exclude<RuleTarget['kind'], 'mcp'>> = {
  bash: 'bash',
  read: 'read',
  glob: 'read',
  grep: 'read',
  ls: 'read',
  edit: 'edit',
  write: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  webfetch: 'webfetch',
  websearch: 'websearch',
};

export class RuleError extends Error {
  constructor(rule: string, why: string) {
    super(`permission rule "${rule}": ${why}`);
    this.name = 'RuleError';
  }
}

export function parseRule(text: string): PermissionRule {
  const m = /^\s*([A-Za-z_][\w-]*(?:__\*)?)\s*(?:\((.*)\))?\s*$/s.exec(text);
  if (!m?.[1])
    throw new RuleError(text, 'expected Tool or Tool(specifier), e.g. bash(git status:*)');
  const name = m[1];
  const specifier = m[2]?.trim();
  if (m[2] !== undefined && !specifier)
    throw new RuleError(text, 'empty parentheses; leave them out to match every call');
  if (name.startsWith('mcp__')) {
    if (specifier) throw new RuleError(text, 'MCP rules take no specifier');
    const [, server, tool] = name.split('__');
    if (!server) throw new RuleError(text, 'expected mcp__<server> or mcp__<server>__<tool>');
    return { text, target: { kind: 'mcp', server, ...(tool && tool !== '*' ? { tool } : {}) } };
  }
  const kind = NAMES[name.toLowerCase()];
  if (!kind)
    throw new RuleError(
      text,
      `unknown tool "${name}"; rules name bash, read, edit, webfetch, websearch, or an MCP tool (mcp__<server>[__<tool>])`,
    );
  return { text, target: { kind }, ...(specifier ? { specifier } : {}) };
}

/** Every rule of a list, or the first problem with one. */
export function ruleProblem(rules: string[]): string | undefined {
  for (const r of rules) {
    try {
      parseRule(r);
    } catch (err) {
      return (err as Error).message;
    }
  }
  return undefined;
}
