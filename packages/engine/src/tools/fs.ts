import { realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import { looksLikeImage, readImage } from '../images.ts';
import {
  defineTool,
  diffPreview,
  resolveFile,
  type ToolContext,
  ToolError,
  toWorkspacePath,
  truncate,
} from './tool.ts';

const PATH_HELP =
  'File path, relative to the workspace root. Paths outside it (absolute, or starting with ~/) ask the user first.';

const IGNORED = /(^|[\\/])(node_modules|\.git|dist|\.tsbuild|\.next|target|\.venv)([\\/]|$)/;

/** Workspace-relative path with forward slashes, so tool output is the same on every OS. */
const workspacePath = (root: string, file: string) => toWorkspacePath(root, file) ?? file;

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a file from the workspace. Text comes back as lines prefixed with 1-based line numbers (use offset/limit for large files); a PNG, JPEG, GIF, or WebP image comes back as the image.',
  schema: z.object({
    path: z.string().describe(PATH_HELP),
    offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum lines to return (default 2000)'),
  }),
  permission: 'read',
  mutating: false,
  summarize: (i) => `read ${i.path}`,
  async run(input, ctx) {
    const file = resolveFile(ctx.workspaceRoot, input.path);
    const info = await stat(file).catch(() => undefined);
    if (!info) throw new ToolError(`${input.path} does not exist`);
    if (info.isDirectory()) throw new ToolError(`${input.path} is a directory; use glob`);
    if (looksLikeImage(input.path)) {
      // `file` is canonical (symlinks resolved); so must the root be to relate them.
      const path = workspacePath(realpathSync(ctx.workspaceRoot), file);
      const image = await readImage(file, path);
      if (typeof image === 'string') throw new ToolError(`${input.path}: ${image}`);
      return { text: `${path}: ${image.mediaType.slice(6).toUpperCase()} image`, images: [image] };
    }
    const lines = (await readFile(file, 'utf8')).split('\n');
    const start = (input.offset ?? 1) - 1;
    const slice = lines.slice(start, start + (input.limit ?? 2000));
    const body = slice.map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`).join('\n');
    const more =
      start + slice.length < lines.length
        ? `\n[${lines.length - start - slice.length} more lines]`
        : '';
    return truncate(body + more);
  },
});

export const writeTool = defineTool({
  name: 'write',
  description: 'Create or overwrite a file with the given content.',
  schema: z.object({
    path: z.string().describe(PATH_HELP),
    content: z.string().describe('Full file content'),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) => `write ${i.path} (${i.content.length} chars)`,
  async preview(input, ctx) {
    const file = resolveFile(ctx.workspaceRoot, input.path);
    validated(ctx, file, input.content);
    const before = await readFile(file, 'utf8').catch(() => '');
    return {
      diff: diffPreview(input.path, before, input.content),
      proposed: { path: input.path, content: input.content },
    };
  },
  async run(input, ctx) {
    const file = resolveFile(ctx.workspaceRoot, input.path);
    validated(ctx, file, input.content);
    const before = await readFile(file, 'utf8').catch(() => '');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.content);
    return {
      text: `wrote ${input.path}`,
      images: [],
      diff: diffPreview(input.path, before, input.content),
    };
  },
});

interface EditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean | undefined;
}

/** A config edit that would break the config fails before anyone is asked. */
function validated(ctx: ToolContext, file: string, content: string): void {
  const problem = ctx.validate?.(file, content);
  if (problem) throw new ToolError(problem);
}

/** Read the file and compute the edited text, or throw the error the model should see. */
async function applyEdit(input: EditInput, ctx: ToolContext) {
  const file = resolveFile(ctx.workspaceRoot, input.path);
  const before = await readFile(file, 'utf8').catch(() => {
    throw new ToolError(`${input.path} does not exist`);
  });
  const count = before.split(input.oldString).length - 1;
  if (count === 0) throw new ToolError('oldString not found in file');
  if (count > 1 && !input.replaceAll)
    throw new ToolError(`oldString matches ${count} times; add context or set replaceAll`);
  const after = input.replaceAll
    ? before.split(input.oldString).join(input.newString)
    : before.replace(input.oldString, () => input.newString);
  validated(ctx, file, after);
  return { file, before, after, replacements: input.replaceAll ? count : 1 };
}

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace an exact string in a file. oldString must match exactly once unless replaceAll is true. Read the file first.',
  schema: z.object({
    path: z.string().describe(PATH_HELP),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) => `edit ${i.path}`,
  async preview(input, ctx) {
    const { before, after } = await applyEdit(input, ctx);
    return {
      diff: diffPreview(input.path, before, after),
      proposed: { path: input.path, content: after },
    };
  },
  async run(input, ctx) {
    const { file, before, after, replacements } = await applyEdit(input, ctx);
    await writeFile(file, after);
    return {
      text: `edited ${input.path} (${replacements} replacement${replacements > 1 ? 's' : ''})`,
      images: [],
      diff: diffPreview(input.path, before, after),
    };
  },
});

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules, .git, and build output.',
  schema: z.object({
    pattern: z.string(),
    path: z
      .string()
      .optional()
      .describe(
        'Directory to search in, relative to the workspace root (outside it asks the user first)',
      ),
  }),
  permission: 'read',
  mutating: false,
  summarize: (i) => `glob ${i.pattern}`,
  async run(input, ctx) {
    const cwd = resolveFile(ctx.workspaceRoot, input.path ?? '.');
    const matches: string[] = [];
    for await (const f of new Glob(input.pattern).scan({ cwd, onlyFiles: true, dot: false })) {
      if (IGNORED.test(f) || ctx.hidden?.(join(cwd, f))) continue;
      matches.push(workspacePath(ctx.workspaceRoot, join(cwd, f)));
      if (matches.length >= 500) break;
    }
    matches.sort();
    return matches.length ? matches.join('\n') : 'no matches';
  },
});

const GREP_LIMIT = 300;

export interface GrepInput {
  pattern: string;
  path?: string | undefined;
  glob?: string | undefined;
  ignoreCase?: boolean | undefined;
}

/** Plain JavaScript search: the fallback when ripgrep is missing or rejects the regex. */
export async function grepJs(input: GrepInput, cwd: string, root: string): Promise<string[]> {
  let re: RegExp;
  try {
    re = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
  } catch (err) {
    throw new ToolError(`invalid regex: ${(err as Error).message}`);
  }
  const out: string[] = [];
  for await (const f of new Glob(input.glob ?? '**/*').scan({ cwd, onlyFiles: true })) {
    if (IGNORED.test(f)) continue;
    const full = join(cwd, f);
    const text = await readFile(full, 'utf8').catch(() => '');
    if (text.includes('\u0000')) continue; // binary
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i] ?? '')) {
        out.push(`${workspacePath(root, full)}:${i + 1}: ${(lines[i] ?? '').slice(0, 300)}`);
        if (out.length >= GREP_LIMIT) return out;
      }
    }
  }
  return out;
}

/**
 * ripgrep search: much faster, and honors .gitignore. Returns undefined when
 * rg can't handle the pattern (its regex dialect lacks lookaround), so the
 * caller can fall back.
 */
export async function grepRipgrep(
  rg: string,
  input: GrepInput,
  cwd: string,
  root: string,
): Promise<string[] | undefined> {
  const args = ['--json', '--no-config', '--no-require-git', '--max-columns', '300'];
  if (input.ignoreCase) args.push('-i');
  for (const dir of ['node_modules', '.git', 'dist', '.tsbuild', '.next', 'target', '.venv'])
    args.push('--glob', `!${dir}`);
  if (input.glob) args.push('--glob', input.glob);
  args.push('-e', input.pattern);
  const proc = Bun.spawn([rg, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const out: string[] = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      const ev = JSON.parse(line) as {
        type: string;
        data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
      };
      if (ev.type !== 'match' || !ev.data.path?.text) continue;
      const text = (ev.data.lines?.text ?? '').replace(/\r?\n$/, '');
      out.push(
        `${workspacePath(root, join(cwd, ev.data.path.text))}:${ev.data.line_number}: ${text}`,
      );
      if (out.length >= GREP_LIMIT) {
        proc.kill();
        return out;
      }
    }
  }
  const code = await proc.exited;
  if (code === 2) {
    const stderr = await new Response(proc.stderr).text();
    // A pattern rg rejects may still be a valid JavaScript regex (e.g. lookaround).
    if (/regex parse error|error parsing regex/i.test(stderr)) return undefined;
    throw new ToolError(stderr.trim().split('\n')[0] ?? 'ripgrep failed');
  }
  return out;
}

let ripgrep: string | null | undefined;

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns path:line: text. Optionally filter files with a glob. Respects .gitignore when ripgrep is installed.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional(),
    glob: z.string().optional().describe('File filter, e.g. "**/*.ts"'),
    ignoreCase: z.boolean().optional(),
  }),
  permission: 'read',
  mutating: false,
  summarize: (i) => `grep ${i.pattern}`,
  async run(input, ctx) {
    const cwd = resolveFile(ctx.workspaceRoot, input.path ?? '.');
    if (ripgrep === undefined) ripgrep = process.env.SWITCHBACK_NO_RIPGREP ? null : Bun.which('rg');
    const found =
      (ripgrep ? await grepRipgrep(ripgrep, input, cwd, ctx.workspaceRoot) : undefined) ??
      (await grepJs(input, cwd, ctx.workspaceRoot));
    // Files deny rules keep from being read don't show up in what they contain either.
    const hidden = ctx.hidden;
    const out = hidden
      ? found.filter((line) => {
          const path = /^(.+?):\d+: /.exec(line)?.[1];
          return !path || !hidden(resolve(ctx.workspaceRoot, path));
        })
      : found;
    if (!out.length) return 'no matches';
    const body = out.join('\n');
    return truncate(out.length >= GREP_LIMIT ? `${body}\n[result limit reached]` : body);
  },
});
