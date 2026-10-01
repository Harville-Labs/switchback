/**
 * Draft locally, review with a stronger model (docs/review.md).
 *
 * After a turn in which a local model edited files, a remote model reviews
 * the turn's diff against the user's request. Reviewing is cheap next to
 * writing: the input is a diff, the output a short verdict. On `revise`, the
 * findings go back to the local model to fix.
 */
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';

export const REVIEWER_PROMPT = `You review code changes that another model made to fulfil a user's request. You see the request, the other model's closing summary, and a unified diff of every file it changed.

Decide:
- "approve" when the change does what was asked and has no bugs you can point to.
- "revise" only for real problems: a bug, a requirement that was missed, broken or missing error handling that matters, a security issue, or a change that clearly breaks something else. Style preferences and optional improvements never warrant "revise".

Be specific: name the file and line, say what is wrong and what to do instead. Do not restate the diff. At most 8 issues, most important first.

Answer with only this JSON object:
{"verdict": "approve" | "revise", "summary": "<one sentence>", "issues": [{"file": "<path>", "line": <number or null>, "severity": "bug" | "risk" | "nit", "comment": "<what is wrong and what to do>"}]}`;

export const ReviewIssue = z.object({
  file: z.string().catch(''),
  line: z.number().int().nullable().optional().catch(null),
  severity: z.enum(['bug', 'risk', 'nit']).catch('risk'),
  comment: z.string(),
});
export type ReviewIssue = z.infer<typeof ReviewIssue>;

const ReviewAnswer = z.object({
  verdict: z.enum(['approve', 'revise']),
  summary: z.string().catch(''),
  issues: z.array(ReviewIssue).catch([]).default([]),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

/** One file changed during the turn: its content before the first edit, and now. */
export interface FileChange {
  path: string;
  before: string | undefined;
  after: string | undefined;
}

/** Unified diff of the turn's changes, capped so a huge change can't blow up the review's cost. */
export function turnDiff(changes: FileChange[], maxLines = 2_000): string {
  const lines: string[] = [];
  for (const c of changes) {
    if (c.before === c.after) continue;
    const patch = createTwoFilesPatch(
      c.before === undefined ? '/dev/null' : `a/${c.path}`,
      c.after === undefined ? '/dev/null' : `b/${c.path}`,
      c.before ?? '',
      c.after ?? '',
      undefined,
      undefined,
      { context: 3 },
    );
    lines.push(...patch.split('\n').filter((l) => !l.startsWith('Index:') && !/^=+$/.test(l)));
  }
  while (lines.at(-1) === '') lines.pop();
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n… ${lines.length - maxLines} more diff lines not shown`;
}

export function reviewRequest(request: string, summary: string, diff: string): string {
  return [
    `<request>\n${request.trim()}\n</request>`,
    `<summary>\n${summary.trim() || '(none)'}\n</summary>`,
    `<diff>\n${diff}\n</diff>`,
  ].join('\n\n');
}

/**
 * The reviewer's verdict, from the first JSON object in its answer. Anything
 * unreadable is treated as no verdict: the turn stands, and nothing loops.
 */
export function parseReview(text: string): ReviewAnswer | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const r = ReviewAnswer.safeParse(JSON.parse(text.slice(start, end + 1)));
    if (!r.success) return undefined;
    // A "revise" with nothing to fix gives the local model nothing to act on.
    if (r.data.verdict === 'revise' && !r.data.issues.some((i) => i.severity !== 'nit'))
      return { ...r.data, verdict: 'approve' };
    return r.data;
  } catch {
    return undefined;
  }
}

/** The message that hands the findings back to the local model. */
export function feedbackText(review: ReviewAnswer, reviewer: string): string {
  const issues = review.issues
    .filter((i) => i.severity !== 'nit')
    .map(
      (i) =>
        `- ${i.file ? `${i.file}${i.line ? `:${i.line}` : ''} ` : ''}[${i.severity}] ${i.comment}`,
    );
  return [
    `A reviewer (${reviewer}) checked your changes and asked for revisions: ${review.summary}`,
    '',
    ...issues,
    '',
    'Fix these issues in the files, then say briefly what you changed. If you disagree with a finding, explain why instead of changing the code.',
  ].join('\n');
}
