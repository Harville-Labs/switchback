/**
 * `@path` mentions in a prompt attach that file's contents to the user
 * message, so every client gets mentions for free.
 */
import { readFile, stat } from 'node:fs/promises';
import type { TextPart } from '@harness/protocol';
import { resolveInWorkspace } from './tools/tool.ts';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 200_000;
const MAX_TOTAL_BYTES = 500_000;

/** Attachment parts for each distinct, readable workspace file mentioned. Unknown mentions are left alone. */
export async function expandMentions(text: string, root: string): Promise<TextPart[]> {
  const paths = [...new Set([...text.matchAll(/(?:^|\s)@([^\s@]+)/g)].map((m) => m[1] ?? ''))]
    .map((p) => p.replace(/[.,;:!?)\]]+$/, '')) // trailing punctuation from prose
    .filter(Boolean)
    .slice(0, MAX_FILES);
  const parts: TextPart[] = [];
  let total = 0;
  for (const path of paths) {
    let file: string;
    try {
      file = resolveInWorkspace(root, path);
    } catch {
      continue; // outside the workspace: not a mention we honor
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (info.size > MAX_FILE_BYTES || total + info.size > MAX_TOTAL_BYTES) {
      parts.push({
        type: 'text',
        text: `<file path="${path}" omitted="too large (${info.size} bytes); use the read tool" />`,
        attachment: { path },
      });
      continue;
    }
    const content = await readFile(file, 'utf8');
    if (content.includes('\u0000')) continue; // binary
    total += info.size;
    parts.push({
      type: 'text',
      text: `<file path="${path}">\n${content}\n</file>`,
      attachment: { path },
    });
  }
  return parts;
}
