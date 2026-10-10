/** Setup's notes as text, for every client that runs setup (`switchback init`, VS Code). */
import type { SetupNote } from '@switchback/protocol';
import { formatRoles } from './format.ts';

export function formatSetupNote(note: SetupNote): string {
  switch (note.kind) {
    case 'roles':
      return formatRoles(note.roles, note.models);
    case 'config':
      return `Configuration to write to ${note.file}\n${JSON.stringify(note.layer, null, 2)}`;
    case 'text':
      return note.tone === 'success'
        ? `✓ ${note.text}`
        : note.tone === 'warning'
          ? `! ${note.text}`
          : note.text;
  }
}
