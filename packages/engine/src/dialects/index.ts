/**
 * Config dialects. A config file says which format it's written in with
 * `$schema`: Switchback's own (or none), or another tool's that Switchback
 * reads, so a team that keeps one config in that tool's format doesn't
 * rewrite it. Each dialect translates what it can into Switchback's keys and
 * reports what it left out; the result is validated like any other layer.
 * Adding a format is adding an entry to `DIALECTS` (ADR 0031).
 */
import type { Obj } from '../setup-flow/opencode-models.ts';
import { translateClaudeCode } from './claude-code.ts';
import { translateOpenCode } from './opencode.ts';

export interface ConfigDialect {
  id: string;
  name: string;
  /** Whether a `$schema` URL names this format. */
  matches(schema: string): boolean;
  translate(raw: Obj): { config: Obj; notes: string[] };
}

export const DIALECTS: readonly ConfigDialect[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    matches: (schema) => /^https?:\/\/([\w-]+\.)?opencode\.ai\//i.test(schema),
    translate: translateOpenCode,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    matches: (schema) =>
      /claude-code-settings|^https?:\/\/([\w-]+\.)?(claude\.(com|ai)|anthropic\.com)\//i.test(
        schema,
      ),
    translate: translateClaudeCode,
  },
];

/** The dialect a config file declares, if it isn't Switchback's own. */
export function dialectOf(raw: Obj): ConfigDialect | undefined {
  const schema = raw.$schema;
  return typeof schema === 'string' ? DIALECTS.find((d) => d.matches(schema)) : undefined;
}

/** A file's contents as Switchback config, with what the translation left out. */
export function applyDialect(raw: Obj): { config: Obj; notes: string[]; dialect?: string } {
  const dialect = dialectOf(raw);
  if (!dialect) return { config: raw, notes: [] };
  const { config, notes } = dialect.translate(raw);
  return { config, notes, dialect: dialect.name };
}
