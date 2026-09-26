import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { Glob } from 'bun';
import { z } from 'zod';
import { defineTool, resolveInWorkspace, ToolError, truncate } from './tool.ts';

const IGNORED = /(^|\/)(node_modules|\.git|dist|\.tsbuild|\.next|target|\.venv)(\/|$)/;

export const readTool = defineTool({
  name: 'read',
  description:
    'Read a text file from the workspace. Returns lines prefixed with 1-based line numbers. Use offset/limit for large files.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
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
    const file = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const info = await stat(file).catch(() => undefined);
    if (!info) throw new ToolError(`${input.path} does not exist`);
    if (info.isDirectory()) throw new ToolError(`${input.path} is a directory; use glob`);
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
  description: 'Create or overwrite a file in the workspace with the given content.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root'),
    content: z.string().describe('Full file content'),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) => `write ${i.path} (${i.content.length} chars)`,
  async run(input, ctx) {
    const file = resolveInWorkspace(ctx.workspaceRoot, input.path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.content);
    return `wrote ${input.path}`;
  },
});

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace an exact string in a file. oldString must match exactly once unless replaceAll is true. Read the file first.',
  schema: z.object({
    path: z.string(),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) => `edit ${i.path}`,
  async run(input, ctx) {
    const file = resolveInWorkspace(ctx.workspaceRoot, input.path);
    const text = await readFile(file, 'utf8').catch(() => {
      throw new ToolError(`${input.path} does not exist`);
    });
    const count = text.split(input.oldString).length - 1;
    if (count === 0) throw new ToolError('oldString not found in file');
    if (count > 1 && !input.replaceAll)
      throw new ToolError(`oldString matches ${count} times; add context or set replaceAll`);
    const next = input.replaceAll
      ? text.split(input.oldString).join(input.newString)
      : text.replace(input.oldString, () => input.newString);
    await writeFile(file, next);
    return `edited ${input.path} (${input.replaceAll ? count : 1} replacement${count > 1 && input.replaceAll ? 's' : ''})`;
  },
});

export const globTool = defineTool({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules, .git, and build output.',
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional().describe('Directory to search in, relative to the workspace root'),
  }),
  permission: 'read',
  mutating: false,
  summarize: (i) => `glob ${i.pattern}`,
  async run(input, ctx) {
    const cwd = resolveInWorkspace(ctx.workspaceRoot, input.path ?? '.');
    const matches: string[] = [];
    for await (const f of new Glob(input.pattern).scan({ cwd, onlyFiles: true, dot: false })) {
      if (IGNORED.test(f)) continue;
      matches.push(relative(ctx.workspaceRoot, `${cwd}/${f}`));
      if (matches.length >= 500) break;
    }
    matches.sort();
    return matches.length ? matches.join('\n') : 'no matches';
  },
});

export const grepTool = defineTool({
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns path:line: text. Optionally filter files with a glob.',
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
    const cwd = resolveInWorkspace(ctx.workspaceRoot, input.path ?? '.');
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
    } catch (err) {
      throw new ToolError(`invalid regex: ${(err as Error).message}`);
    }
    const out: string[] = [];
    for await (const f of new Glob(input.glob ?? '**/*').scan({ cwd, onlyFiles: true })) {
      if (IGNORED.test(f)) continue;
      const full = `${cwd}/${f}`;
      const text = await readFile(full, 'utf8').catch(() => '');
      if (text.includes('\u0000')) continue; // binary
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i] ?? '')) {
          out.push(
            `${relative(ctx.workspaceRoot, full)}:${i + 1}: ${(lines[i] ?? '').slice(0, 300)}`,
          );
          if (out.length >= 300) return truncate(`${out.join('\n')}\n[result limit reached]`);
        }
      }
    }
    return out.length ? truncate(out.join('\n')) : 'no matches';
  },
});
