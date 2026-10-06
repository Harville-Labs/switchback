import { z } from 'zod';
import { defineTool, type ToolContext, ToolError, truncate } from './tool.ts';

/** Longest a foreground command may run, whatever it asks for. */
const MAX_TIMEOUT_MS = 600_000;

function commands(ctx: ToolContext) {
  if (!ctx.commands) throw new ToolError('shell commands are not available here');
  return ctx.commands;
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace root and return stdout, stderr, and the exit code. Use for builds, tests, and git. For something that keeps running (a dev server, a watcher), set background: true and read its output later with bash_output. The environment section of the system prompt names the shell.',
  schema: z.object({
    command: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('Foreground only; the default is set in config (bash.timeoutMs)'),
    background: z
      .boolean()
      .optional()
      .describe(
        'Start it and return at once; read output with bash_output, stop it with kill_shell',
      ),
  }),
  permission: 'bash',
  mutating: true,
  summarize: (i) => `$ ${i.command}${i.background ? ' (background)' : ''}`,
  async run(input, ctx) {
    const runner = commands(ctx);
    if (input.background) {
      const shell = runner.start(ctx.sessionId, input.command, ctx.workspaceRoot);
      return `started background shell ${shell.id}. Read its output with bash_output({ "id": "${shell.id}" }); stop it with kill_shell.`;
    }
    const proc = runner.spawn(input.command, ctx.workspaceRoot);
    const timeoutMs = Math.min(input.timeoutMs ?? runner.timeoutMs, MAX_TIMEOUT_MS);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    const onAbort = () => proc.kill();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const ended = timedOut
        ? `timed out after ${timeoutMs / 1000}s (killed); for long-running commands use background: true`
        : proc.signalCode
          ? `killed (${proc.signalCode})`
          : String(code);
      const parts = [
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
        `exit code: ${ended}`,
      ].filter(Boolean);
      return truncate(parts.join('\n'));
    } finally {
      clearTimeout(timeout);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  },
});

export const bashOutputTool = defineTool({
  name: 'bash_output',
  description:
    'Read what a background shell (started with bash background: true) printed since you last read it, and whether it is still running.',
  schema: z.object({ id: z.string().describe('The shell ID bash returned, e.g. sh_1a2b3c') }),
  // The command was approved when it started; reading its output asks nothing new.
  permission: 'none',
  mutating: false,
  summarize: (i) => `output of ${i.id}`,
  async run(input, ctx) {
    const { shell, output, skipped } = commands(ctx).read(input.id, ctx.sessionId);
    const state =
      shell.status === 'running'
        ? 'still running'
        : shell.status === 'killed'
          ? 'killed'
          : `exited with code ${shell.exitCode}`;
    // The command comes first: the privacy check reads it from there (privacy.ts).
    return truncate(
      [
        `$ ${shell.command}`,
        `[${shell.id}: ${state}]`,
        skipped ? `[${skipped} earlier characters were dropped]` : '',
        output || '(no new output)',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
});

export const killShellTool = defineTool({
  name: 'kill_shell',
  description: 'Stop a background shell started with bash background: true.',
  schema: z.object({ id: z.string() }),
  permission: 'none',
  mutating: true,
  summarize: (i) => `stop ${i.id}`,
  async run(input, ctx) {
    const shell = commands(ctx).kill(input.id, ctx.sessionId);
    return `${shell.id} ${shell.status === 'killed' ? 'stopped' : `had already exited (code ${shell.exitCode})`}`;
  },
});
