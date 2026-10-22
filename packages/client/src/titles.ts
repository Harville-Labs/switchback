/** Session titles as both clients show them. */
import type { TitleSource } from '@switchback/protocol';

/** The note in the transcript when a session is renamed; none for the first prompt's title. */
export function renamedLabel(title: string, source: TitleSource): string | undefined {
  if (source === 'user') return `Renamed to "${title}"`;
  if (source === 'compaction') return `Retitled "${title}" from the summary`;
  return undefined;
}

/**
 * The terminal's title for a session. Control characters are dropped so a
 * title can't end the escape sequence it's sent in.
 */
export function terminalTitle(title: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = (title ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return clean ? `${clean} · Switchback` : 'Switchback';
}
