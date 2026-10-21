/**
 * Keys removed by role-based routing (ADR 0015), with what replaced them. Zod
 * would drop them silently, which would quietly change how someone's turns
 * route; config loading reports them, and writing a layer migrates them.
 */
export const REMOVED_KEYS: {
  path: string[];
  message: string;
  when?: (value: unknown) => boolean;
}[] = [
  {
    path: ['routing', 'classifier'],
    message:
      'routing.classifier was removed: escalation is automatic when a model struggles, and /up or Escalate now in VS Code moves a turn up the ladder on demand (docs/routing.md)',
  },
  {
    path: ['routing', 'local'],
    message:
      'routing.local was renamed routing.current: the models turns begin on (docs/routing.md)',
  },
  {
    path: ['routing', 'remote'],
    message:
      'routing.remote was replaced by routing.escalate, an ordered ladder of any models; for example "escalate": [["remote"]] (docs/routing.md)',
  },
  {
    path: ['routing', 'mode'],
    message:
      'routing.mode was removed: list the models you want in routing.current and routing.escalate, or set routing.allowRemote: false to keep remote models unused (docs/routing.md)',
  },
  {
    path: ['routing', 'escalation', 'via'],
    message:
      'routing.escalation.via was replaced by routing.escalate, which lists every step (docs/routing.md)',
  },
  {
    path: ['routing', 'fallback'],
    // Only the old object form; "nearest" and "none" are the new values.
    when: (v) => typeof v === 'object' && v !== null,
    message:
      'routing.fallback is now "nearest" (use the nearest other step that is up) or "none" (docs/routing.md)',
  },
  {
    path: ['review', 'model'],
    message:
      'review.model was replaced by review.models, the reviewers in order; for example "models": ["large"] (docs/review.md)',
  },
];

/** The removed keys a layer still sets. */
export function removedKeysIn(layer: unknown): (typeof REMOVED_KEYS)[number][] {
  return REMOVED_KEYS.filter(({ path, when }) => {
    let node: unknown = layer;
    for (const key of path) {
      if (!node || typeof node !== 'object' || !(key in node)) return false;
      node = (node as Record<string, unknown>)[key];
    }
    return when ? when(node) : true;
  });
}

/** The first removed key a layer sets, as a message naming its replacement. */
export function removedKeyProblem(layer: unknown): string | undefined {
  return removedKeysIn(layer)[0]?.message;
}

/**
 * Keys that were renamed without changing what they do. Unlike removed keys
 * they keep working: loading reads them under the new name, and writing a
 * layer moves them, so an old file never fails and never routes differently.
 */
export const RENAMED_KEYS: { from: string[]; to: string[] }[] = [
  // The model turns begin on is the current model (docs/routing.md).
  { from: ['routing', 'start'], to: ['routing', 'current'] },
];

/** A layer with renamed keys under their new names; the new name wins when a layer sets both. */
export function withRenamedKeys<T>(layer: T): T {
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return layer;
  let out = layer as Record<string, unknown>;
  for (const { from, to } of RENAMED_KEYS) {
    const parentPath = from.slice(0, -1);
    const parent = valueAt(out, parentPath);
    const oldKey = from.at(-1) as string;
    const newKey = to.at(-1) as string;
    if (!parent || typeof parent !== 'object' || !(oldKey in parent)) continue;
    // Both keys share a parent (a rename in place), so rebuild only that path.
    const { [oldKey]: value, ...rest } = parent as Record<string, unknown>;
    out = setAt(out, parentPath, newKey in rest ? rest : { ...rest, [newKey]: value });
  }
  return out as T;
}

/** The renamed keys a layer still sets, for migrating its file. */
export function renamedKeysIn(layer: unknown): (typeof RENAMED_KEYS)[number][] {
  return RENAMED_KEYS.filter(({ from }) => {
    const parent = valueAt(layer, from.slice(0, -1));
    return !!parent && typeof parent === 'object' && (from.at(-1) as string) in parent;
  });
}

function valueAt(node: unknown, path: string[]): unknown {
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function setAt(
  node: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  const [key, ...more] = path;
  if (key === undefined) return value as Record<string, unknown>;
  const child = (node[key] ?? {}) as Record<string, unknown>;
  return { ...node, [key]: setAt(child, more, value) };
}
