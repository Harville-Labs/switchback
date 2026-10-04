/**
 * Evaluate the pre-routing classifier on the labeled prompt set.
 *
 *   bun scripts/eval-classifier.ts --base-url http://localhost:11434/v1 --model qwen3:1.7b
 *   TYPESAFE_API_KEY=... bun scripts/eval-classifier.ts --typesafe --model jev-latest
 *
 * Reports precision and recall for "hard" (the prompts it would escalate),
 * accuracy, unparseable replies, and latency. Writes a Markdown table to
 * $GITHUB_STEP_SUMMARY when set. Never fails the build: it's a measurement.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyPrompt } from '@switchback/engine';
import { OpenAICompatibleProvider, TypeSafeProvider } from '@switchback/providers';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string' },
    /** A System One server (TypeSafe Jev, or OpenJev at --base-url) instead of a chat model. */
    typesafe: { type: 'boolean', default: false },
    model: { type: 'string' },
    'timeout-ms': { type: 'string', default: '10000' },
    'escalate-on': { type: 'string', default: 'hard' },
  },
});
if (!values.model) {
  console.error('usage: bun scripts/eval-classifier.ts --model <name> [--base-url <url>]');
  process.exit(2);
}

const rows = readFileSync(join(import.meta.dir, '../tests/classifier/labeled.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { prompt: string; label: 'easy' | 'hard' });

const provider = values.typesafe
  ? new TypeSafeProvider({
      id: 'eval',
      tier: 'remote',
      ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
      ...(process.env.TYPESAFE_API_KEY ? { apiKey: process.env.TYPESAFE_API_KEY } : {}),
    })
  : new OpenAICompatibleProvider({
      id: 'eval',
      baseUrl: values['base-url'] ?? 'http://localhost:11434/v1',
      tier: 'local',
    });
const rank = { easy: 0, medium: 1, hard: 2 } as const;
const bar = values['escalate-on'] === 'medium' ? 1 : 2;

// Warm the model so load time doesn't count as latency.
await classifyPrompt(provider, values.model, 'hello', { timeoutMs: 120_000 });

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
let unparsed = 0;
const latencies: number[] = [];
for (const row of rows) {
  const r = await classifyPrompt(provider, values.model, row.prompt, {
    timeoutMs: Number(values['timeout-ms']),
  });
  latencies.push(r.ms);
  if (!r.difficulty) unparsed++;
  const predicted = r.difficulty ? rank[r.difficulty.level] >= bar : false;
  const actual = row.label === 'hard';
  if (predicted && actual) tp++;
  else if (predicted) fp++;
  else if (actual) fn++;
  else tn++;
  console.log(
    `${actual ? 'hard' : 'easy'} → ${r.difficulty?.level ?? '??'} ${Math.round(r.ms)}ms  ${row.prompt.slice(0, 70)}`,
  );
}

latencies.sort((a, b) => a - b);
const pct = (p: number) => Math.round(latencies[Math.floor((latencies.length - 1) * p)] ?? 0);
const ratio = (a: number, b: number) => (b ? (a / b).toFixed(2) : 'n/a');
const table = [
  `### Classifier eval: \`${values.model}\` (escalate on ${values['escalate-on']})`,
  '',
  '| Prompts | Precision (hard) | Recall (hard) | Accuracy | Unparsed | p50 | p90 |',
  '|---|---|---|---|---|---|---|',
  `| ${rows.length} | ${ratio(tp, tp + fp)} | ${ratio(tp, tp + fn)} | ${ratio(tp + tn, rows.length)} | ${unparsed} | ${pct(0.5)} ms | ${pct(0.9)} ms |`,
  '',
].join('\n');
console.log(`\n${table}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
