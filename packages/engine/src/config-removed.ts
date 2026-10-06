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
    path: ['routing', 'local'],
    message: 'routing.local was renamed routing.start: the models turns begin on (docs/routing.md)',
  },
  {
    path: ['routing', 'remote'],
    message:
      'routing.remote was replaced by routing.escalate, an ordered ladder of any models; for example "escalate": [["remote"]] (docs/routing.md)',
  },
  {
    path: ['routing', 'mode'],
    message:
      'routing.mode was removed: list the models you want in routing.start and routing.escalate, or set routing.allowRemote: false to keep remote models unused (docs/routing.md)',
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
