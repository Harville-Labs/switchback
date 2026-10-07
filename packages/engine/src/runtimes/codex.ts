/**
 * OpenAI Codex as a subagent, through the Codex SDK, working in this
 * workspace. Codex runs non-interactively and can't ask about each call, so
 * the whole run is put to the switchback policy once (as a command), and the
 * sandbox mode bounds what it can change. Its token usage is priced from the
 * catalog.
 *
 * The SDK runs the Codex CLI: `executable`, else `codex` on PATH, else the
 * CLI the SDK ships with.
 */
import type { Codex, CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import { costUsd, priceFor } from '@switchback/providers';
import type { AgentRuntime, RuntimeResult, RuntimeTask } from './runtime.ts';

export interface CodexRuntimeOptions {
  /** Runtime name from config, used as the ledger's provider. */
  name: string;
  model?: string;
  sandbox: 'read-only' | 'workspace-write';
  network: boolean;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  executable?: string;
  apiKey?: string;
  /** Injected for tests; defaults to the SDK's `Codex`. */
  codex?: Pick<Codex, 'startThread' | 'resumeThread'>;
}

export class CodexRuntime implements AgentRuntime {
  readonly label = 'OpenAI Codex';
  readonly unaskedReads = true;

  constructor(private readonly options: CodexRuntimeOptions) {}

  private async codex(): Promise<Pick<Codex, 'startThread' | 'resumeThread'>> {
    if (this.options.codex) return this.options.codex;
    // Loaded on first use: most sessions never start an external runtime.
    const { Codex } = await import('@openai/codex-sdk');
    const path = this.options.executable ?? Bun.which('codex') ?? undefined;
    const opts: CodexOptions = {
      ...(path ? { codexPathOverride: path } : {}),
      ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
    };
    return new Codex(opts);
  }

  async run(task: RuntimeTask): Promise<RuntimeResult> {
    const { sandbox, network, model } = this.options;
    // One decision for the whole run, as a command line so rules can match it
    // (`bash(codex:*)`): Codex can't stop to ask about each command.
    const approval = await task.canUseTool('codex', {
      command: `codex exec --sandbox ${sandbox}${network ? ' --network' : ''}`,
      prompt: task.prompt.slice(0, 200),
    });
    if (!approval.allowed)
      return {
        ok: false,
        text:
          approval.message ??
          "Codex wasn't approved to run. It works without asking about each command, so it's approved per run (choose Always to stop being asked); headless runs need --allow 'bash(codex:*)'.",
        calls: [],
      };
    try {
      const codex = await this.codex();
      const options: ThreadOptions = {
        workingDirectory: task.cwd,
        sandboxMode: sandbox,
        networkAccessEnabled: network,
        // Approved above; inside the sandbox it runs without asking.
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        ...(model ? { model } : {}),
        ...(this.options.effort ? { modelReasoningEffort: this.options.effort } : {}),
      };
      const thread = task.resume
        ? codex.resumeThread(task.resume, options)
        : codex.startThread(options);
      const { events } = await thread.runStreamed(task.prompt, { signal: task.signal });
      let last = '';
      let sessionId: string | undefined;
      for await (const event of events) {
        if (event.type === 'thread.started') sessionId = event.thread_id;
        const done = this.handle(event, task, (t) => (last = t));
        if (!done) continue;
        // The thread to resume next time: from its start event, else the SDK's handle.
        const id = sessionId ?? thread.id ?? undefined;
        return { ...done, ...(done.ok ? { text: last } : {}), ...(id ? { sessionId: id } : {}) };
      }
      return { ok: false, text: 'Codex ended without finishing', calls: [] };
    } catch (err) {
      if (task.signal.aborted) return { ok: false, text: 'cancelled', calls: [] };
      return { ok: false, text: (err as Error).message, calls: [] };
    }
  }

  /** One event: progress for the session, or the end of the run. */
  private handle(
    event: ThreadEvent,
    task: RuntimeTask,
    said: (text: string) => void,
  ): RuntimeResult | undefined {
    if (event.type === 'turn.failed') return { ok: false, text: event.error.message, calls: [] };
    if (event.type === 'error') return { ok: false, text: event.message, calls: [] };
    if (event.type === 'turn.completed') {
      const u = event.usage;
      const usage = {
        inputTokens: u.input_tokens - u.cached_input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cached_input_tokens,
        cacheWriteTokens: u.cache_write_input_tokens,
      };
      const model = this.options.model ?? 'codex';
      return {
        ok: true,
        text: '',
        calls: [
          {
            model: { provider: this.options.name, model },
            usage,
            costUsd: costUsd(usage, priceFor(model)),
          },
        ],
      };
    }
    if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
    const item = event.item;
    const started = event.type === 'item.started';
    if (item.type === 'agent_message' && !started) {
      said(item.text);
      task.onEvent({ type: 'text', text: item.text });
    } else if (item.type === 'command_execution') {
      if (started)
        task.onEvent({
          type: 'tool.started',
          callId: item.id,
          name: 'bash',
          input: { command: item.command },
        });
      else
        task.onEvent({
          type: 'tool.completed',
          callId: item.id,
          name: 'bash',
          output: item.aggregated_output,
          isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
        });
    } else if (item.type === 'file_change' && !started) {
      // A patch arrives once, applied or not: start and finish it together.
      const input = { changes: item.changes.map((c) => `${c.kind} ${c.path}`) };
      task.onEvent({ type: 'tool.started', callId: item.id, name: 'edit', input });
      task.onEvent({
        type: 'tool.completed',
        callId: item.id,
        name: 'edit',
        output: input.changes.join('\n'),
        isError: item.status === 'failed',
      });
    } else if (item.type === 'mcp_tool_call') {
      const name = `mcp__${item.server}__${item.tool}`;
      if (started)
        task.onEvent({ type: 'tool.started', callId: item.id, name, input: item.arguments });
      else
        task.onEvent({
          type: 'tool.completed',
          callId: item.id,
          name,
          output: item.error?.message ?? JSON.stringify(item.result?.content ?? ''),
          isError: item.status === 'failed',
        });
    }
    return undefined;
  }
}
