/**
 * The TUI's colors, by role rather than by name, so every row agrees on what
 * "remote" or "removed" looks like and a light terminal gets readable ones.
 * `plain` uses no color at all, for terminals and people who'd rather not.
 * The choice is the user's display preference, kept with the TUI's other
 * state (prompt history) rather than in the engine's configuration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { switchbackPaths } from '@switchback/engine';
import { createContext, useContext } from 'react';

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
  /** Permission modes, as the status bar's badge shows them. */
  modes: Record<'default' | 'acceptEdits' | 'plan' | 'bypassPermissions', string | undefined>;
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
  modes: {
    default: undefined,
    acceptEdits: '#c084fc',
    plan: '#38bdf8',
    bypassPermissions: '#f87171',
  },
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
  modes: {
    default: undefined,
    acceptEdits: '#7e22ce',
    plan: '#0369a1',
    bypassPermissions: '#b91c1c',
  },
};

const PLAIN: Theme = {
  name: 'plain',
  modes: {
    default: undefined,
    acceptEdits: undefined,
    plan: undefined,
    bypassPermissions: undefined,
  },
};

export const THEMES: Record<ThemeName, Theme> = { dark: DARK, light: LIGHT, plain: PLAIN };

export const ThemeContext = createContext<Theme>(DARK);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

const prefsFile = () => join(switchbackPaths().dataDir, 'tui.json');

/** The theme chosen last time, or dark. */
export function savedTheme(file = prefsFile()): ThemeName {
  try {
    if (!existsSync(file)) return 'dark';
    const name = (JSON.parse(readFileSync(file, 'utf8')) as { theme?: unknown }).theme;
    return THEME_NAMES.includes(name as ThemeName) ? (name as ThemeName) : 'dark';
  } catch {
    return 'dark';
  }
}

export function saveTheme(name: ThemeName, file = prefsFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ theme: name })}\n`);
  } catch {
    // A preference that can't be saved still applies for this session.
  }
}
