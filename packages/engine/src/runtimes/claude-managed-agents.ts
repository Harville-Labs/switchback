/**
 * Claude Managed Agents: an agent you defined on the Claude Platform, run in
 * a session in one of your environments (a hosted sandbox). It works on what
 * that environment has, not on this workspace.
 *
 * Tool calls the agent's permission policy marks `ask` are put to the
 * switchback policy and answered with a tool confirmation; the agent's own
 * policy decides the rest. Usage is priced from the catalog.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { costUsd, priceFor } from '@switchback/providers';
import type { AgentRuntime, RuntimeResult, RuntimeTask } from './runtime.ts';

export interface ManagedAgentsOptions {
  /** Runtime name from config, used as the ledger's provider. */
  name: string;
  agent: string;
  environment: string;
  model?: string;
  apiKey?: string;
  /** Injected for tests; otherwise built from the SDK. */
  client?: ManagedAgentsClient;
}

/** The part of the SDK client this uses. */
export type ManagedAgentsClient = Pick<Anthropic['beta'], 'agents' | 'sessions'>;

interface Block {
  type: string;
  text?: string;
}

const text = (content: Block[] | undefined) =>
  (content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');

export class ManagedAgentsRuntime implements AgentRuntime {
  readonly label = 'Claude Managed Agents';

  constructor(private readonly options: ManagedAgentsOptions) {}

  private async client(): Promise<ManagedAgentsClient> {
    if (this.options.client) return this.options.client;
    // Loaded on first use: most sessions never start an external runtime.
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const sdk = new Anthropic(this.options.apiKey ? { apiKey: this.options.apiKey } : {});
    return sdk.beta;
  }

  /** The agent's model, for pricing: from config, else from the agent. */
  private async model(client: ManagedAgentsClient): Promise<string> {
    if (this.options.model) return this.options.model;
    const agent = (await client.agents.retrieve(this.options.agent)) as {
      model?: string | { id?: string };
    };
    return typeof agent.model === 'string' ? agent.model : (agent.model?.id ?? this.options.agent);
  }

  async run(task: RuntimeTask): Promise<RuntimeResult> {
    let sessionId: string | undefined;
    let client: ManagedAgentsClient | undefined;
    const onAbort = () => {
      if (client && sessionId)
        void client.sessions.events
          .send(sessionId, { events: [{ type: 'user.interrupt' }] })
          .catch(() => {});
    };
    task.signal.addEventListener('abort', onAbort, { once: true });
    try {
      client = await this.client();
      const model = await this.model(client);
      const session = await client.sessions.create({
        agent: this.options.agent,
        environment_id: this.options.environment,
        title: task.prompt.slice(0, 80),
      });
      sessionId = session.id;
      // Open the stream before sending, so no event is missed.
      const stream = await client.sessions.events.stream(session.id);
      await client.sessions.events.send(session.id, {
        events: [{ type: 'user.message', content: [{ type: 'text', text: task.prompt }] }],
      });
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const names = new Map<string, string>();
      let last = '';
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        const e = event as {
          type: string;
          id: string;
          name?: string;
          input?: unknown;
          content?: Block[];
          tool_use_id?: string;
          mcp_tool_use_id?: string;
          is_error?: boolean | null;
          evaluated_permission?: string;
          model_usage?: Record<string, number>;
          stop_reason?: { type: string };
          error?: { message?: string };
        };
        if (e.type === 'agent.message') {
          last = text(e.content);
          if (last) task.onEvent({ type: 'text', text: last });
        } else if (e.type === 'agent.tool_use' || e.type === 'agent.mcp_tool_use') {
          const name = e.name ?? 'tool';
          names.set(e.id, name);
          task.onEvent({ type: 'tool.started', callId: e.id, name, input: e.input });
          if (e.evaluated_permission === 'ask') {
            const r = await task.canUseTool(name, (e.input ?? {}) as Record<string, unknown>);
            await client.sessions.events.send(session.id, {
              events: [
                {
                  type: 'user.tool_confirmation',
                  tool_use_id: e.id,
                  result: r.allowed ? 'allow' : 'deny',
                  ...(r.allowed
                    ? {}
                    : { deny_message: r.message ?? 'The user denied this action.' }),
                },
              ],
            });
          }
        } else if (e.type === 'agent.tool_result' || e.type === 'agent.mcp_tool_result') {
          const callId = e.tool_use_id ?? e.mcp_tool_use_id ?? '';
          task.onEvent({
            type: 'tool.completed',
            callId,
            name: names.get(callId) ?? 'tool',
            output: text(e.content),
            isError: e.is_error === true,
          });
        } else if (e.type === 'span.model_request_end' && e.model_usage) {
          const u = e.model_usage;
          usage.inputTokens += u.input_tokens ?? 0;
          usage.outputTokens += u.output_tokens ?? 0;
          usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
        } else if (e.type === 'session.error') {
          return this.done(false, e.error?.message ?? 'the session failed', model, usage);
        } else if (e.type === 'session.status_idle' && e.stop_reason?.type !== 'requires_action') {
          // requires_action: waiting on the confirmation just sent. Anything else ends the run.
          return this.done(true, last, model, usage);
        }
      }
      return this.done(false, 'the session ended without finishing', model, usage);
    } catch (err) {
      if (task.signal.aborted) return { ok: false, text: 'cancelled', calls: [] };
      return { ok: false, text: (err as Error).message, calls: [] };
    } finally {
      task.signal.removeEventListener('abort', onAbort);
    }
  }

  private done(
    ok: boolean,
    text: string,
    model: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    },
  ): RuntimeResult {
    // Token costs only: sandbox time is billed by the platform separately.
    const cost = costUsd(usage, priceFor(model));
    return {
      ok,
      text,
      calls: [{ model: { provider: this.options.name, model }, usage, costUsd: cost }],
    };
  }
}
