import { z } from 'zod';
import { currentShell } from './shell.ts';
import { defineTool, truncate } from './tool.ts';

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace root and return stdout, stderr, and the exit code. Use for builds, tests, and git. The environment section of the system prompt names the shell.',
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().max(600_000).optional().describe('Default 120000'),
  }),
  permission: 'bash',
  mutating: true,
  summarize: (i) => `$ ${i.command}`,
  async run(input, ctx) {
    const proc = Bun.spawn(currentShell().argv(input.command), {
      cwd: ctx.workspaceRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, SWITCHBACK: '1' },
    });
    const timeout = setTimeout(() => proc.kill(), input.timeoutMs ?? 120_000);
    const onAbort = () => proc.kill();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const parts = [
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
        `exit code: ${proc.signalCode ? `killed (${proc.signalCode})` : code}`,
      ].filter(Boolean);
      return truncate(parts.join('\n'));
    } finally {
      clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
});
