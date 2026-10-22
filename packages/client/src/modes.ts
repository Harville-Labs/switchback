/**
 * Permission modes, rules, and routing, in words: the mode pickers, `/mode`,
 * `/permissions`, and the routing control.
 */
import type {
  EngineEvent,
  PermissionMode,
  PermissionsListResult,
  RoutePreference,
} from '@switchback/protocol';

/**
 * Routing preferences as people see them. `auto` reads as auto-escalate:
 * a bare "auto" next to the permission mode was taken for auto-approval.
 */
export const ROUTES: readonly { value: RoutePreference; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'auto-escalate',
    description: 'run on the current model; escalate when stuck',
  },
  { value: 'local', label: 'local only', description: 'only local models for the next prompts' },
  {
    value: 'remote',
    label: 'remote only',
    description: 'only hosted models for the next prompts',
  },
];

export function routeLabel(route: RoutePreference): string {
  return ROUTES.find((r) => r.value === route)?.label ?? route;
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'default',
  acceptEdits: 'accept edits',
  autoApprove: 'auto-approve',
  plan: 'plan',
  bypassPermissions: 'bypass permissions',
};

/** What each mode does, for pickers and `/mode`. */
export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'ask before edits and commands, as the permission levels say',
  acceptEdits: 'edits in the workspace go ahead; commands still ask',
  autoApprove:
    'a model approves calls that fit your request; it asks you about anything risky or unclear',
  plan: 'read and plan only; nothing changes until you approve the plan',
  bypassPermissions: 'everything goes ahead without asking; only deny rules stop a call',
};

/** A call `autoApprove`'s judge let through, and why. */
export function judgedLabel(e: Extract<EngineEvent, { type: 'permission.judged' }>): string {
  return `auto-approved ${e.summary}${e.judge ? ` (${e.judge})` : ''}: ${e.reason}`;
}

export function modeLabel(mode: PermissionMode): string {
  return MODE_LABELS[mode];
}

/** A mode as people type it: `plan`, `accept-edits`, `bypass`, or the config name. */
export function parseMode(input: string): PermissionMode | undefined {
  const key = input.toLowerCase().replace(/[-_\s]/g, '');
  const aliases: Record<string, PermissionMode> = {
    default: 'default',
    normal: 'default',
    acceptedits: 'acceptEdits',
    accept: 'acceptEdits',
    autoapprove: 'autoApprove',
    autoapproval: 'autoApprove',
    judge: 'autoApprove',
    plan: 'plan',
    bypass: 'bypassPermissions',
    bypasspermissions: 'bypassPermissions',
  };
  return aliases[key];
}

/** The mode after `current` when cycling (Shift+Tab), among those allowed. */
export function nextMode(current: PermissionMode, allowed: PermissionMode[]): PermissionMode {
  const i = allowed.indexOf(current);
  return allowed[(i + 1) % allowed.length] ?? 'default';
}

/** `/mode` with no argument: each mode this session allows, the current one marked. */
export function formatModes(modes: PermissionMode[], current: PermissionMode | undefined): string {
  const width = Math.max(...modes.map((m) => modeLabel(m).length));
  return [
    ...modes.map(
      (m) => `${m === current ? '●' : ' '} ${modeLabel(m).padEnd(width)}  ${MODE_DESCRIPTIONS[m]}`,
    ),
    '/mode <name> to switch; Shift+Tab cycles',
  ].join('\n');
}

/** `/permissions`: the mode, the levels, and every rule with where it came from. */
export function formatPermissions(p: PermissionsListResult): string {
  const row = (label: string, text: string) => `${label.padEnd(8)}${text}`;
  const lines = [
    ...(p.mode ? [row('mode', `${modeLabel(p.mode)}: ${MODE_DESCRIPTIONS[p.mode]}`)] : []),
    row(
      'levels',
      `read ${p.levels.read} · edit ${p.levels.edit} · bash ${p.levels.bash} · web ${p.levels.web} · websearch ${p.levels.websearch} · mcp ${p.levels.mcp}`,
    ),
    row(
      'sandbox',
      p.sandbox.active ? 'on: bash commands run in the OS sandbox' : `off: ${p.sandbox.reason}`,
    ),
  ];
  if (!p.rules.length) lines.push(row('rules', 'none (see docs/permissions.md)'));
  else {
    lines.push('rules');
    // Grouped by where they came from, then by behavior: a config holds dozens.
    const sources = [...new Set(p.rules.map((r) => r.source))];
    for (const source of sources) {
      lines.push(`  ${source}`);
      for (const behavior of ['deny', 'ask', 'allow'] as const) {
        const rules = p.rules.filter((r) => r.source === source && r.behavior === behavior);
        if (rules.length)
          lines.push(
            ...wrapList(
              `    ${behavior.padEnd(6)}`,
              rules.map((r) => r.rule),
            ),
          );
      }
    }
  }
  return lines.join('\n');
}

/** Items joined with commas, wrapped under the label at 100 columns. */
function wrapList(label: string, items: string[]): string[] {
  const indent = ' '.repeat(label.length);
  const lines: string[] = [];
  let line = '';
  for (const [i, item] of items.entries()) {
    const text = i < items.length - 1 ? `${item},` : item;
    const prefix = lines.length ? indent : label;
    if (line && prefix.length + line.length + 1 + text.length > 100) {
      lines.push(prefix + line);
      line = text;
    } else line = line ? `${line} ${text}` : text;
  }
  lines.push((lines.length ? indent : label) + line);
  return lines;
}
