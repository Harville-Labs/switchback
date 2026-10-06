/**
 * Privacy: content that must never reach a remote model.
 *
 * Two mechanisms. `privacy.localOnlyPaths` marks transcript parts that carry
 * content from matching files; a session holding one is pinned local by the
 * router's `privacy` guard for the rest of its life, since later local output
 * may repeat what it saw. `privacy.secrets` scans what is about to be sent to
 * a remote model and redacts (or blocks on) credentials, using secretlint's
 * maintained rules.
 *
 * Redaction changes only the outbound copy, never the transcript (invariant
 * 4), and is deterministic, so consecutive remote calls keep the same prefix
 * and still hit the prompt cache.
 */
import { sep } from 'node:path';
import { lintSource } from '@secretlint/core';
import { creator as recommended } from '@secretlint/secretlint-rule-preset-recommend';
import type { Message, Part } from '@switchback/protocol';
import { Glob } from 'bun';
import { toWorkspacePath } from './tools/tool.ts';

export type PrivatePathMatcher = (workspacePath: string) => boolean;

/**
 * Globs relative to the workspace root. A pattern without a slash also
 * matches by file name anywhere, as in `.gitignore` (`*.pem`, `.env*`).
 */
export function privatePathMatcher(patterns: string[]): PrivatePathMatcher | undefined {
  if (!patterns.length) return undefined;
  const globs = patterns.map((p) => {
    const pattern = p.replace(/^\.\//, '').replace(/\/$/, '/**');
    return new Glob(pattern.includes('/') ? pattern : `{${pattern},**/${pattern}}`);
  });
  return (path) => {
    const p = path.split(sep).join('/').replace(/^\.\//, '');
    return globs.some((g) => g.match(p) || g.match(`${p}/`));
  };
}

/** Words of a shell command that look like paths: split on whitespace and shell punctuation, quotes removed. */
function commandWords(command: string): string[] {
  return command
    .split(/[\s;|&<>()`]+/)
    .map((w) => w.replace(/^['"]|['"]$/g, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, ''))
    .filter((w) => w && !w.startsWith('-'));
}

/**
 * Why a tool call brought private content into the session, or undefined.
 * Paths come from the call's input; for grep, from the files its output
 * quotes. bash commands are checked by the paths they name: a script that
 * reads a private file indirectly isn't detected (see docs/privacy.md).
 */
export function privateToolUse(
  matches: PrivatePathMatcher,
  root: string,
  tool: string,
  input: unknown,
  output: string,
): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const check = (path: unknown) => {
    if (typeof path !== 'string') return undefined;
    // The workspace root itself ("") isn't a file a pattern can match.
    const p = toWorkspacePath(root, path) || undefined;
    return p && matches(p) ? p : undefined;
  };
  if (tool === 'read' || tool === 'edit' || tool === 'write') {
    const p = check(i.path);
    return p ? `${tool} ${p}` : undefined;
  }
  if (tool === 'grep') {
    for (const line of output.split('\n')) {
      const m = /^(.+?):\d+: /.exec(line);
      const p = m && check(m[1]);
      if (p) return `grep matched ${p}`;
    }
    return undefined;
  }
  // A background shell's output starts with its command (bash_output in tools/bash.ts).
  const command =
    tool === 'bash' ? i.command : tool === 'bash_output' ? /^\$ (.*)/.exec(output)?.[1] : undefined;
  if (typeof command === 'string') {
    for (const word of commandWords(command)) {
      const p = check(word);
      if (p) return `a command named ${p}`;
    }
  }
  return undefined;
}

/** The first reason any part of the conversation must stay local. */
export function privateReason(messages: Message[]): string | undefined {
  for (const m of messages)
    for (const p of m.parts)
      if ((p.type === 'text' || p.type === 'tool_result') && p.private) return p.private;
  return undefined;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const RULES = {
  rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommended }],
};

export interface SecretScan {
  text: string;
  /** Kinds of secret found, e.g. `GITHUB_TOKEN`. */
  found: string[];
}

/** Scans are pure; cache them so each part is scanned once, not on every call. */
const scans = new Map<string, Promise<SecretScan>>();
const MAX_CACHED = 5_000;

/** Replace each secret in `text` with a placeholder naming its kind. */
export function redactSecrets(text: string): Promise<SecretScan> {
  const hit = scans.get(text);
  if (hit) return hit;
  const scan = scanText(text);
  if (scans.size >= MAX_CACHED) scans.delete(scans.keys().next().value as string);
  scans.set(text, scan);
  return scan;
}

async function scanText(text: string): Promise<SecretScan> {
  // Nothing secret fits in fewer characters than the shortest token rules match.
  if (text.length < 16) return { text, found: [] };
  const result = await lintSource({
    source: { filePath: 'outbound.txt', content: text, contentType: 'text' },
    options: { config: RULES },
  });
  if (!result.messages.length) return { text, found: [] };
  const ranges = result.messages
    .map((m) => ({ start: m.range[0], end: m.range[1], kind: m.messageId }))
    .sort((a, b) => a.start - b.start);
  let out = '';
  let at = 0;
  const found: string[] = [];
  for (const r of ranges) {
    if (r.start < at) continue; // overlapping findings: the first one covers it
    out += `${text.slice(at, r.start)}[redacted ${r.kind}]`;
    at = r.end;
    found.push(r.kind);
  }
  return { text: out + text.slice(at), found };
}

async function redactValue(value: unknown, found: string[]): Promise<unknown> {
  if (typeof value === 'string') {
    const r = await redactSecrets(value);
    found.push(...r.found);
    return r.text;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => redactValue(v, found)));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([k, v]) => [k, await redactValue(v, found)] as const),
      ),
    );
  return value;
}

/**
 * The outbound copy of a request with secrets redacted. Reasoning parts pass
 * through: adapters only replay them to the model that produced them, and a
 * remote model's own reasoning came from what it was already sent.
 */
export async function redactOutbound(
  system: string,
  messages: Message[],
): Promise<{ system: string; messages: Message[]; found: string[] }> {
  const found: string[] = [];
  const redactPart = async (p: Part): Promise<Part> => {
    if (p.type === 'text') {
      const r = await redactSecrets(p.text);
      found.push(...r.found);
      return r.found.length ? { ...p, text: r.text } : p;
    }
    if (p.type === 'tool_result') {
      const r = await redactSecrets(p.content);
      found.push(...r.found);
      return r.found.length ? { ...p, content: r.text } : p;
    }
    if (p.type === 'tool_call') {
      const before = found.length;
      const input = await redactValue(p.input, found);
      return found.length > before ? { ...p, input } : p;
    }
    return p;
  };
  const sys = await redactSecrets(system);
  found.push(...sys.found);
  const out = await Promise.all(
    messages.map(async (m) => ({ ...m, parts: await Promise.all(m.parts.map(redactPart)) })),
  );
  return { system: sys.text, messages: out, found };
}
