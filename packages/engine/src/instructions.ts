/**
 * The AGENTS.md files that go into every session's system prompt (yours,
 * then the project's), and how much of a model's context window they take.
 * Every session pays for them, subagents included, so a large file crowds
 * out small local models.
 */
import { existsSync, readFileSync } from 'node:fs';
import { projectPaths, switchbackPaths } from './paths.ts';
import { countTokens } from './tokens.ts';

export interface InstructionsFile {
  scope: 'user' | 'project';
  path: string;
  text: string;
}

/** Above this share of the smallest context window, `doctor` warns. */
export const INSTRUCTIONS_WARN_SHARE = 0.1;

/** The instruction files that exist and aren't blank, yours first. */
export function instructionFiles(
  workspaceRoot: string,
  env: Record<string, string | undefined> = process.env,
): InstructionsFile[] {
  const files: InstructionsFile[] = [];
  const candidates = [
    { scope: 'user' as const, path: switchbackPaths(env).instructionsFile },
    { scope: 'project' as const, path: projectPaths(workspaceRoot).instructionsFile },
  ];
  for (const { scope, path } of candidates) {
    const text = readInstructions(path);
    if (text) files.push({ scope, path, text });
  }
  return files;
}

/** An AGENTS.md's text, or undefined when there's none or it's blank. */
export function readInstructions(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  return text.trim() ? text : undefined;
}

export interface InstructionsUsage {
  files: { scope: InstructionsFile['scope']; path: string; tokens: number }[];
  total: number;
  /** The smallest context window it was measured against; undefined when none is known. */
  window?: number;
  /** Set when the files take more than `INSTRUCTIONS_WARN_SHARE` of that window. */
  warning?: string;
}

/** Token counts for each file, and a warning when together they're too big for `windows`. */
export function instructionsUsage(files: InstructionsFile[], windows: number[]): InstructionsUsage {
  const counted = files.map((f) => ({ scope: f.scope, path: f.path, tokens: countTokens(f.text) }));
  const total = counted.reduce((n, f) => n + f.tokens, 0);
  const known = windows.filter((w) => w > 0);
  if (!known.length) return { files: counted, total };
  const window = Math.min(...known);
  const share = total / window;
  return {
    files: counted,
    total,
    window,
    ...(share > INSTRUCTIONS_WARN_SHARE
      ? {
          warning: `AGENTS.md instructions take ${Math.round(share * 100)}% of the smallest context window (${window.toLocaleString('en-US')} tokens), in every session and subagent. Shorten them, or move how-to detail into skills, which load only when needed.`,
        }
      : {}),
  };
}
