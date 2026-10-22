/**
 * The TUI's display preferences (theme, mouse), kept with its other state
 * (prompt history) rather than in the engine's configuration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { switchbackPaths } from '@switchback/engine';

export const prefsFile = () => join(switchbackPaths().dataDir, 'tui.json');

/** What the file holds, unchecked: each reader validates its own key. */
export function readPrefs(file = prefsFile()): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {};
    const prefs: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Set one preference, keeping the others. */
export function savePref(key: string, value: unknown, file = prefsFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ ...readPrefs(file), [key]: value })}\n`);
  } catch {
    // A preference that can't be saved still applies for this session.
  }
}
