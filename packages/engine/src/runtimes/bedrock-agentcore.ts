/**
 * An agent deployed to Amazon Bedrock AgentCore Runtime. It runs in AWS with
 * its own tools and permissions, so nothing here is asked about: switchback
 * sends the task, shows what streams back, and reports the answer. AgentCore
 * doesn't report model usage, so these runs aren't costed in the ledger.
 *
 * Credentials and region come from the AWS SDK's usual chain (environment,
 * profile, SSO, instance role), as for the Bedrock provider.
 */
import type {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import type { AgentRuntime, RuntimeResult, RuntimeTask } from './runtime.ts';

export interface AgentCoreOptions {
  name: string;
  arn: string;
  qualifier?: string;
  region?: string;
  /** Injected for tests: sends the invocation and returns the SDK's output. */
  invoke?: (
    input: {
      agentRuntimeArn: string;
      qualifier?: string;
      runtimeSessionId: string;
      payload: Uint8Array;
      contentType: string;
      accept: string;
    },
    signal: AbortSignal,
  ) => Promise<Pick<InvokeAgentRuntimeCommandOutput, 'contentType' | 'response'>>;
}

/** `arn:aws:bedrock-agentcore:<region>:…` */
const regionOf = (arn: string) => arn.split(':')[3] || undefined;

export class AgentCoreRuntime implements AgentRuntime {
  readonly label = 'Amazon Bedrock AgentCore';
  private client: BedrockAgentCoreClient | undefined;

  constructor(private readonly options: AgentCoreOptions) {}

  private async invoke(
    input: Parameters<NonNullable<AgentCoreOptions['invoke']>>[0],
    signal: AbortSignal,
  ) {
    if (this.options.invoke) return this.options.invoke(input, signal);
    // Loaded on first use: most sessions never start an external runtime.
    const sdk = await import('@aws-sdk/client-bedrock-agentcore');
    const region = this.options.region ?? regionOf(this.options.arn);
    this.client ??= new sdk.BedrockAgentCoreClient(region ? { region } : {});
    return this.client.send(new sdk.InvokeAgentRuntimeCommand(input), { abortSignal: signal });
  }

  async run(task: RuntimeTask): Promise<RuntimeResult> {
    try {
      const out = await this.invoke(
        {
          agentRuntimeArn: this.options.arn,
          ...(this.options.qualifier ? { qualifier: this.options.qualifier } : {}),
          // AgentCore wants at least 33 characters; a UUID without dashes is 32.
          runtimeSessionId: `switchback-${crypto.randomUUID()}`,
          payload: new TextEncoder().encode(JSON.stringify({ prompt: task.prompt })),
          contentType: 'application/json',
          accept: 'text/event-stream, application/json',
        },
        task.signal,
      );
      const body = out.response as
        | { transformToWebStream?: () => ReadableStream<Uint8Array> }
        | undefined;
      const stream = body?.transformToWebStream?.();
      if (!stream) return { ok: false, text: 'AgentCore returned no response', calls: [] };
      const text = out.contentType?.includes('text/event-stream')
        ? await this.readEvents(stream, task)
        : answerOf(await new Response(stream).text());
      if (!out.contentType?.includes('text/event-stream') && text)
        task.onEvent({ type: 'text', text });
      return { ok: true, text, calls: [] };
    } catch (err) {
      if (task.signal.aborted) return { ok: false, text: 'cancelled', calls: [] };
      return { ok: false, text: (err as Error).message, calls: [] };
    }
  }

  /** Server-sent events: each `data:` line is a piece of the answer, shown as it arrives. */
  private async readEvents(stream: ReadableStream<Uint8Array>, task: RuntimeTask): Promise<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    const line = (l: string) => {
      if (!l.startsWith('data:')) return;
      const piece = answerOf(l.slice(5).trim());
      if (!piece) return;
      answer += piece;
      task.onEvent({ type: 'text', text: piece });
    };
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(line);
    }
    line(buffer);
    return answer;
  }
}

/**
 * What an agent sent, as text. Agents choose their own format: a JSON string,
 * an object with the text in a common field, or plain text.
 */
export function answerOf(raw: string): string {
  if (!raw) return '';
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const k of ['result', 'response', 'output', 'text', 'message', 'data'])
        if (typeof o[k] === 'string') return o[k] as string;
      return JSON.stringify(v);
    }
    return String(v);
  } catch {
    return raw;
  }
}
