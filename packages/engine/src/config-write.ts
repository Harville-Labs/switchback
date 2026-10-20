/** Writing setup's answers into a config file, keeping the user's edits. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { applyEdits, type JSONPath, modify } from 'jsonc-parser';
import {
  deepMerge,
  layerProblem,
  parseJsonc,
  removedKeysIn,
  renamedKeysIn,
  SECRET_KEY,
  withRenamedKeys,
} from './config.ts';

/** Whether a config holds a secret as is, rather than as an `{env:NAME}` reference. */
export function holdsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([k, v]) =>
    typeof v === 'string'
      ? SECRET_KEY.test(k) && v !== '' && !/^\{env:[^}]+\}$/.test(v)
      : holdsSecret(v),
  );
}

export interface WriteResult {
  file: string;
  backup?: string;
  config: Record<string, unknown>;
}

/** Each leaf of a layer as a JSON path; arrays and empty objects are leaves. */
function leaves(layer: Record<string, unknown>, prefix: JSONPath = []): [JSONPath, unknown][] {
  return Object.entries(layer).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length
      ? leaves(v as Record<string, unknown>, [...prefix, k])
      : [[[...prefix, k], v] as [JSONPath, unknown]],
  );
}

/**
 * Merge a layer into a config file (creating it if needed), validating the
 * result against the schema first. Edits are applied in place, so the user's
 * comments and formatting survive; the previous file is still kept as `.bak`.
 */
export function writeConfigLayer(
  file: string,
  layer: Record<string, unknown>,
  options: {
    /**
     * Check that aliases resolve within this file alone. Off when the caller
     * already checked them against the merged config (models may live in
     * another file, an org policy, or the project config).
     */
    references?: boolean;
    /** Top-level sections to replace whole rather than merge into. */
    replace?: string[];
  } = {},
): WriteResult {
  let text = '{}';
  let backup: string | undefined;
  if (existsSync(file)) {
    text = readFileSync(file, 'utf8');
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  // Keys role-based routing removed (ADR 0015) under a section this layer
  // writes are deleted, so re-running setup migrates an old file instead of
  // failing on it.
  for (const { path } of removedKeysIn(parseJsonc(text)))
    if (path[0] && path[0] in layer) text = applyEdits(text, modify(text, path, undefined, {}));
  // Renamed keys move to their new name, keeping their value, whatever the layer writes.
  for (const { from, to } of renamedKeysIn(parseJsonc(text))) {
    const value = withRenamedKeys(parseJsonc(text) as Record<string, unknown>);
    const moved = to.reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], value);
    text = applyEdits(text, modify(text, from, undefined, {}));
    text = applyEdits(
      text,
      modify(text, to, moved, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  for (const key of options.replace ?? [])
    text = applyEdits(text, modify(text, [key], undefined, {}));
  const existing = parseJsonc(text) as Record<string, unknown>;
  const merged = deepMerge(existing, layer);
  const problem = layerProblem(merged, { references: options.references !== false });
  if (problem) throw new Error(`setup produced an invalid config: ${problem}`);
  for (const [path, value] of leaves(layer)) {
    text = applyEdits(
      text,
      modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  // A pasted API key makes the file (and its backup, which may hold the same
  // key) readable by its owner alone.
  if (holdsSecret(merged)) for (const f of [file, backup]) if (f) chmodSync(f, 0o600);
  return { file, ...(backup ? { backup } : {}), config: merged };
}
