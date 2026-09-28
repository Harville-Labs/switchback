/**
 * What happens to pasted text in the prompt. Kept free of Ink so it can be
 * unit-tested.
 *
 * - Terminal escape sequences and stray control characters are removed (text
 *   copied from another terminal often carries colors), and line endings are
 *   normalized.
 * - A big paste shows as a one-line chip, `[Pasted text #1 · 240 lines]`, so
 *   the prompt stays editable; the full text is sent when the prompt is.
 * - A pasted or dragged-in file path becomes an `@` mention when the file is
 *   in the workspace, so its contents are attached.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** Larger pastes become a chip. */
export const CHIP_MIN_LINES = 12;
export const CHIP_MIN_CHARS = 1_500;

const CHIP = /\[Pasted text #(\d+) · [^\]]*\]/g;

export function cleanPaste(text: string): string {
  return (
    stripVTControlCharacters(text)
      .replace(/\r\n?/g, '\n')
      // C0 controls other than tab and newline (and DEL) have no business in a prompt.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}

export interface Pastes {
  next: number;
  texts: Record<number, string>;
}

export const noPastes: Pastes = { next: 1, texts: {} };

function describe(text: string): string {
  const lines = text.split('\n').length;
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

/**
 * What to insert for a paste: the text itself, or a chip for a big one (and
 * the updated paste store).
 */
export function pasteInsertion(text: string, pastes: Pastes): { insert: string; pastes: Pastes } {
  const lines = text.split('\n').length;
  if (lines < CHIP_MIN_LINES && text.length < CHIP_MIN_CHARS) return { insert: text, pastes };
  const id = pastes.next;
  return {
    insert: `[Pasted text #${id} · ${describe(text)}]`,
    pastes: { next: id + 1, texts: { ...pastes.texts, [id]: text } },
  };
}

/** The prompt as sent: every chip replaced by the text it stands for. */
export function expandPastes(value: string, pastes: Pastes): string {
  return value.replace(CHIP, (chip, id: string) => pastes.texts[Number(id)] ?? chip);
}

/** If the cursor sits right after a chip, where the chip starts (backspace removes it whole). */
export function chipBefore(value: string, cursor: number, pastes: Pastes): number | undefined {
  const before = value.slice(0, cursor);
  const m = /\[Pasted text #(\d+) · [^\]]*\]$/.exec(before);
  return m && pastes.texts[Number(m[1])] !== undefined ? m.index : undefined;
}

/**
 * A single pasted path, as terminals produce it when a file is dragged in:
 * possibly quoted, with backslash-escaped spaces, or a `file://` URL.
 */
export function pastedPath(text: string): string | undefined {
  let t = text.trim();
  if (!t || t.includes('\n')) return undefined;
  if (t.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(t).pathname);
    } catch {
      return undefined;
    }
  }
  if (/^(['"]).*\1$/.test(t)) t = t.slice(1, -1);
  // POSIX shells escape spaces with backslashes; on Windows the backslash is the separator.
  else if (!/^[A-Za-z]:\\/.test(t)) t = t.replace(/\\(.)/g, '$1');
  const looksLikePath = t.startsWith('/') || t.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(t);
  return looksLikePath ? t : undefined;
}

/**
 * Turn a dropped file into a mention when it's inside the workspace; an
 * outside file stays a plain (quoted if needed) path, since mentions only
 * attach workspace files.
 */
export function pathInsertion(
  path: string,
  root: string,
  isFile: (abs: string) => boolean,
  home = process.env.HOME ?? '',
): string | undefined {
  const abs = path.startsWith('~/') ? resolve(home, path.slice(2)) : resolve(path);
  if (!isFile(abs)) return undefined;
  const rel = relative(root, abs);
  const inside = rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  if (inside && !/\s/.test(rel)) return `@${rel.split(sep).join('/')} `;
  return /\s/.test(abs) ? `"${abs}" ` : `${abs} `;
}
