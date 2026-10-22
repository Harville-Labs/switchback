/**
 * The TUI's colors, by role rather than by name, so every row agrees on what
 * "remote" or "removed" looks like and a light terminal gets readable ones.
 * `plain` uses no color at all, for terminals and people who'd rather not.
 * The choice is saved with the TUI's other preferences (`prefs.ts`).
 */
import type { PermissionLevel } from '@switchback/protocol';
import { createContext, useContext } from 'react';
import { prefsFile, readPrefs, savePref } from './prefs.ts';

export const THEME_NAMES = ['dark', 'light', 'plain'] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export interface Theme {
  name: ThemeName;
  /** Switchback's own mark and the focused border. */
  brand?: string;
  /** Selections, keys in hints, the prompt arrow. */
  accent?: string;
  success?: string;
  error?: string;
  warning?: string;
  /** Local models (free) and remote ones (they cost). */
  local?: string;
  remote?: string;
  thinking?: string;
  /** Diff lines: text and the band behind it. */
  added?: string;
  removed?: string;
  addedBg?: string;
  removedBg?: string;
  /** An agent other than build, in the status bar. */
  agent?: string;
  /** Permission levels, as the status bar's badge shows them. */
  levels: Record<PermissionLevel, string | undefined>;
}

const DARK: Theme = {
  name: 'dark',
  brand: '#2dd4bf',
  accent: '#5eead4',
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  local: '#4ade80',
  remote: '#fbbf24',
  thinking: '#c084fc',
  added: '#bbf7d0',
  removed: '#fecaca',
  addedBg: '#123524',
  removedBg: '#3f1519',
  agent: '#38bdf8',
  levels: { ask: undefined, auto: '#fbbf24', bypass: '#f87171' },
};

const LIGHT: Theme = {
  name: 'light',
  brand: '#0f766e',
  accent: '#0d9488',
  success: '#15803d',
  error: '#b91c1c',
  warning: '#b45309',
  local: '#15803d',
  remote: '#b45309',
  thinking: '#7e22ce',
  added: '#14532d',
  removed: '#7f1d1d',
  addedBg: '#dcfce7',
  removedBg: '#fee2e2',
  agent: '#0369a1',
  levels: { ask: undefined, auto: '#a16207', bypass: '#b91c1c' },
};

const PLAIN: Theme = {
  name: 'plain',
  levels: { ask: undefined, auto: undefined, bypass: undefined },
};

export const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT, plain: PLAIN };

export const ThemeContext = createContext<Theme>(DARK);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** The theme chosen last time, or dark. */
export function savedTheme(file = prefsFile()): ThemeName {
  const name = readPrefs(file).theme;
  return THEME_NAMES.includes(name as ThemeName) ? (name as ThemeName) : 'dark';
}

export function saveTheme(name: ThemeName, file = prefsFile()): void {
  savePref('theme', name, file);
}
