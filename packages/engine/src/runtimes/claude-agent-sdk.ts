/**
 * Claude Code as a subagent, through the Claude Agent SDK. Claude Code brings
 * its own tools; each call is put to the harness permission policy through
 * `canUseTool`, and its cost is taken from the SDK's result.
 *
 * The SDK runs Claude Code's native executable, which isn't bundled with
 * Harness: the `claude` on PATH is used unless `executable` says otherwise.
 */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntime, RuntimeResult, RuntimeTask } from './runtime.ts';

export interface ClaudeAgentSdkOptions {
  /** Runtime name from config, used as the ledger's provider. */
  name: string;
  model?: string;
  maxTurns?: number;
  executable?: string;
  /** Injected for tests; defaults to the SDK's `query`. */
  query?: (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string }) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('');
}

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly label = 'the Claude Agent SDK';

  constructor(private readonly options: ClaudeAgentSdkOptions) {}

  private async queryFn() {
    if (this.options.query) return this.options.query;
    // Loaded on first use: most sessions never start an external runtime.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    return sdk.query as (params: { prompt: string; options?: Options }) => Query;
  }

  private executable(): string | undefined {
    return this.options.executable ?? Bun.which('claude') ?? undefined;
  }

  async run(task: RuntimeTask): Promise<RuntimeResult> {
    const query = await this.queryFn();
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    task.signal.addEventListener('abort', onAbort, { once: true });
    const names = new Map<string, string>();
    const executable = this.executable();
    try {
      const stream = query({
        prompt: task.prompt,
        options: {
          cwd: task.cwd,
          abortController,
          // Every tool call is asked about; the engine answers with its policy.
          permissionMode: 'default',
          canUseTool: async (name, input) => {
            const r = await task.canUseTool(name, input);
            return r.allowed
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: r.message ?? 'The user denied this action.' };
          },
          // Reproducible runs: don't pick up the machine's Claude Code settings.
          settingSources: [],
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
          ...(task.budgetUsd !== undefined ? { maxBudgetUsd: task.budgetUsd } : {}),
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        },
      });
      for await (const msg of stream) {
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text)
              task.onEvent({ type: 'text', text: block.text });
            else if (block.type === 'tool_use') {
              names.set(block.id, block.name);
              task.onEvent({
                type: 'tool.started',
                callId: block.id,
                name: block.name,
                input: block.input,
              });
            }
          }
        } else if (msg.type === 'user' && msg.parent_tool_use_id === null) {
          const content = msg.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content as {
            type: string;
            tool_use_id?: string;
            content?: unknown;
            is_error?: boolean;
          }[]) {
            if (block.type !== 'tool_result' || !block.tool_use_id) continue;
            task.onEvent({
              type: 'tool.completed',
              callId: block.tool_use_id,
              name: names.get(block.tool_use_id) ?? 'tool',
              output: blockText(block.content),
              isError: block.is_error === true,
            });
          }
        } else if (msg.type === 'result') {
          const calls = Object.entries(msg.modelUsage ?? {}).map(([model, u]) => ({
            model: { provider: this.options.name, model },
            usage: {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadInputTokens,
              cacheWriteTokens: u.cacheCreationInputTokens,
            },
            costUsd: u.costUSD,
          }));
          if (msg.subtype === 'success' && !msg.is_error)
            return { ok: true, text: msg.result, calls };
          const why =
            msg.subtype === 'success'
              ? msg.result
              : msg.subtype === 'error_max_budget_usd'
                ? `stopped at its $${task.budgetUsd?.toFixed(2) ?? '?'} budget`
                : [msg.subtype, ...msg.errors].join(': ');
          return { ok: false, text: why, calls };
        }
      }
      return { ok: false, text: 'the runtime ended without a result', calls: [] };
    } catch (err) {
      if (task.signal.aborted) return { ok: false, text: 'cancelled', calls: [] };
      const message = (err as Error).message;
      const hint = executable
        ? ''
        : ' (Claude Code was not found: install it or set runtimes.<name>.executable)';
      return { ok: false, text: `${message}${hint}`, calls: [] };
    } finally {
      task.signal.removeEventListener('abort', onAbort);
    }
  }
}
