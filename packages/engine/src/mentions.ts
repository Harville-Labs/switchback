/**
 * `@path` mentions in a prompt attach that file's contents to the user
 * message, so every client gets mentions for free.
 */
import { readFile, stat } from 'node:fs/promises';
import type { Attachment, TextPart } from '@switchback/protocol';
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

/** Turn client attachments into attachment parts. Files are read from the workspace only. */
export async function expandAttachments(
  attachments: Attachment[],
  root: string,
): Promise<TextPart[]> {
  const parts: TextPart[] = [];
  let total = 0;
  for (const a of attachments) {
    if (a.kind === 'text') {
      if (total + a.text.length > MAX_TOTAL_BYTES) continue;
      total += a.text.length;
      parts.push({
        type: 'text',
        text: `<context label="${escAttr(a.label)}">\n${a.text}\n</context>`,
        attachment: { path: a.label },
      });
      continue;
    }
    let file: string;
    try {
      file = resolveInWorkspace(root, a.path);
    } catch {
      continue;
    }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES * 5) continue;
    const content = await readFile(file, 'utf8');
    if (content.includes('\u0000')) continue;
    const lines = content.split('\n');
    const start = a.startLine ?? 1;
    const end = Math.min(a.endLine ?? lines.length, lines.length);
    const slice = lines.slice(start - 1, end).join('\n');
    if (total + slice.length > MAX_TOTAL_BYTES) continue;
    total += slice.length;
    const range = a.startLine ? `:${start}-${end}` : '';
    parts.push({
      type: 'text',
      text: `<file path="${escAttr(a.path)}"${a.startLine ? ` lines="${start}-${end}"` : ''}>\n${slice}\n</file>`,
      attachment: { path: `${a.path}${range}` },
    });
  }
  return parts;
}

function escAttr(s: string): string {
  return s.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}
