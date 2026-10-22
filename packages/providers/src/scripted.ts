/**
 * Deterministic provider driven by a script of canned turns. Used by the test
 * suite and by `switchback --provider mock` for demos and client development
 * without any model running.
 */
import type { Part, StopReason, Tier, Usage } from '@switchback/protocol';
import type { ChatEvent, ChatRequest, HealthStatus, Provider } from './types.ts';

export interface ScriptedTurn {
  /** Thinking, streamed before the text and kept as a reasoning part from this model. */
  reasoning?: string;
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  stopReason?: StopReason;
  usage?: Usage;
  /** Throw instead of responding, to exercise fallback paths. */
  error?: Error;
}

export type Script = ScriptedTurn[] | ((request: ChatRequest, turn: number) => ScriptedTurn);

export class ScriptedProvider implements Provider {
  readonly requests: ChatRequest[] = [];
  private turn = 0;

  constructor(
    readonly id: string,
    readonly tier: Tier,
    private readonly script: Script,
    private readonly healthy = true,
  ) {}

  async health(): Promise<HealthStatus> {
    return { ok: this.healthy, detail: this.healthy ? 'scripted' : 'scripted (down)' };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request);
    const index = this.turn++;
    const step: ScriptedTurn =
      typeof this.script === 'function'
        ? this.script(request, index)
        : (this.script[index] ?? { text: '(script exhausted)' });
    if (step.error) throw step.error;

    const parts: Part[] = [];
    if (step.reasoning) {
      for (const word of step.reasoning.split(/(?<=\s)/))
        yield { type: 'reasoning.delta', text: word };
      parts.push({
        type: 'reasoning',
        text: step.reasoning,
        origin: { provider: this.id, model: request.model },
      });
    }
    if (step.text) {
      for (const word of step.text.split(/(?<=\s)/)) yield { type: 'text.delta', text: word };
      parts.push({ type: 'text', text: step.text });
    }
    for (const [i, call] of (step.toolCalls ?? []).entries()) {
      parts.push({ type: 'tool_call', id: `${this.id}_${index}_${i}`, ...call });
    }
    yield {
      type: 'done',
      parts,
      usage: step.usage ?? { inputTokens: 100, outputTokens: 20 },
      stopReason: step.stopReason ?? (step.toolCalls?.length ? 'tool_use' : 'end_turn'),
    };
  }
}

/**
 * Simulated prefix caching for the mock provider: each request reads from
 * cache the bytes it shares with the previous request of the same session
 * (about four characters a token), so `--mock` shows a live hit rate and a
 * change that breaks the prompt prefix shows up as a drop.
 */
export function prefixCache(): (request: ChatRequest) => Usage {
  const previous = new Map<string, string>();
  return (request) => {
    const key = request.cacheKey ?? '';
    const bytes = JSON.stringify([request.system, request.tools, request.messages]);
    const before = previous.get(key) ?? '';
    previous.set(key, bytes);
    let shared = 0;
    while (shared < before.length && before[shared] === bytes[shared]) shared++;
    const read = Math.floor(shared / 4);
    return {
      inputTokens: Math.ceil(bytes.length / 4) - read,
      outputTokens: 20,
      cacheReadTokens: read,
      cacheWriteTokens: 0,
    };
  };
}
