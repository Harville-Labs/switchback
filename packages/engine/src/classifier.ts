/**
 * Pre-routing difficulty classifier (optional, off by default). A small model
 * rates the user's prompt before the first model call of a turn, so obviously
 * hard tasks start one step up the escalation ladder instead of failing on the
 * start model first. The router stays pure: the rating is just another input.
 */
import type { Usage } from '@switchback/protocol';
import type { Provider } from '@switchback/providers';
import type { Difficulty } from '@switchback/router';

export const CLASSIFIER_PROMPT = `You triage requests to a coding agent that runs on a small local model and can hand hard work to a stronger hosted model.

Rate how hard the request is for the small model:
- easy: questions about the code, finding things, explanations, small single-file edits, renames, running commands or tests, simple scripts.
- medium: ordinary features or bug fixes touching a few files.
- hard: subtle bugs (concurrency, memory, security, numerical), large refactors or migrations across many files, architecture and design work, performance work that needs deep analysis, complex algorithms.

Reply with only a JSON object: {"difficulty": "easy" | "medium" | "hard", "reason": "<at most 12 words>"}`;

const MAX_PROMPT_CHARS = 4_000;

/** The same rating as a rubric, for decision models that answer typed questions (Jev). */
export const DIFFICULTY_RUBRIC = {
  instructions:
    'This is a request to a coding agent that runs on a small local model and can hand hard work to a stronger hosted model. How hard is the request for the small model?',
  levels: [
    'Easy: questions about the code, finding things, explanations, small single-file edits, renames, running commands or tests, simple scripts.',
    'Medium: ordinary features or bug fixes touching a few files.',
    'Hard: subtle bugs (concurrency, memory, security, numerical), large refactors or migrations across many files, architecture and design work, performance work that needs deep analysis, complex algorithms.',
  ],
} as const;

const LEVELS = ['easy', 'medium', 'hard'] as const;

/** Pull a rating out of a small model's reply, tolerating chatter around the JSON. */
export function parseDifficulty(text: string): Difficulty | undefined {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const json = cleaned.match(/\{[\s\S]*?\}/)?.[0];
  if (json) {
    try {
      const v = JSON.parse(json) as { difficulty?: unknown; reason?: unknown };
      if (v.difficulty === 'easy' || v.difficulty === 'medium' || v.difficulty === 'hard')
        return {
          level: v.difficulty,
          reason: typeof v.reason === 'string' ? v.reason.slice(0, 120) : '',
        };
    } catch {
      // fall through to the keyword scan
    }
  }
  const word = cleaned.toLowerCase().match(/\b(easy|medium|hard)\b/)?.[1];
  return word ? { level: word as Difficulty['level'], reason: '' } : undefined;
}

/**
 * Rate one prompt. Resolves undefined on timeout, error, or an unparseable
 * reply: a classifier that can't answer quickly must never delay the turn.
 */
export async function classifyPrompt(
  provider: Provider,
  model: string,
  prompt: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ difficulty?: Difficulty; usage?: Usage; ms: number }> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  if (provider.rate) {
    try {
      const r = await provider.rate({
        model,
        ...DIFFICULTY_RUBRIC,
        text: prompt.slice(0, MAX_PROMPT_CHARS),
        signal,
        timeoutMs: options.timeoutMs,
      });
      return {
        difficulty: {
          level: LEVELS[r.level] ?? 'medium',
          reason: `score ${r.score.toFixed(2)} of 2, confidence ${r.confidence.toFixed(2)}`,
        },
        usage: r.usage,
        ms: performance.now() - started,
      };
    } catch {
      return { ms: performance.now() - started };
    }
  }
  try {
    let text = '';
    let usage: Usage | undefined;
    for await (const ev of provider.stream({
      model,
      system: CLASSIFIER_PROMPT,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: prompt.slice(0, MAX_PROMPT_CHARS) }] },
      ],
      tools: [],
      maxTokens: 256,
      // A rating needs no chain of thought, and thinking models would blow the timeout.
      effort: 'none',
      signal,
    })) {
      if (ev.type === 'done') {
        usage = ev.usage;
        text = ev.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
      }
    }
    const difficulty = parseDifficulty(text);
    return {
      ...(difficulty ? { difficulty } : {}),
      ...(usage ? { usage } : {}),
      ms: performance.now() - started,
    };
  } catch {
    return { ms: performance.now() - started };
  }
}
