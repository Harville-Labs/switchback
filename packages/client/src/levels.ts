/**
 * Agents, permission levels, rules, and routing, in words: the pickers,
 * `/agent`, `/permissions`, and the routing control.
 */
import type {
  AgentSummary,
  EngineEvent,
  PermissionLevel,
  PermissionsListResult,
  RoutePreference,
} from '@switchback/protocol';

/**
 * Routing preferences as people see them. `auto` reads as auto-escalate:
 * a bare "auto" next to the permission level was taken for auto-approval.
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

const LEVEL_LABELS: Record<PermissionLevel, string> = {
  ask: 'ask',
  auto: 'auto-approve',
  bypass: 'bypass permissions',
};

/** What each permission level does, for pickers and `/permissions`. */
export const LEVEL_DESCRIPTIONS: Record<PermissionLevel, string> = {
  ask: 'the permission levels and rules decide; anything that asks, asks you',
  auto: 'a model approves calls that fit your request; it asks you about anything risky or unclear',
  bypass: 'everything goes ahead without asking; only deny rules stop a call',
};

/** A call the `auto` level's judge let through, and why. */
export function judgedLabel(e: Extract<EngineEvent, { type: 'permission.judged' }>): string {
  return `auto-approved ${e.summary}${e.judge ? ` (${e.judge})` : ''}: ${e.reason}`;
}

export function levelLabel(level: PermissionLevel): string {
  return LEVEL_LABELS[level];
}

/**
 * A level as people type it. The names permission modes had before ADR 0029
 * (`default`, `autoApprove`, `bypassPermissions`) still work.
 */
export function parseLevel(input: string): PermissionLevel | undefined {
  const key = input.toLowerCase().replace(/[-_\s]/g, '');
  const aliases: Record<string, PermissionLevel> = {
    ask: 'ask',
    default: 'ask',
    normal: 'ask',
    auto: 'auto',
    autoapprove: 'auto',
    autoapproval: 'auto',
    judge: 'auto',
    bypass: 'bypass',
    bypasspermissions: 'bypass',
  };
  return aliases[key];
}

/** The agent a top-level session works as, from the latest event or else its summary. */
export function sessionAgent(view: { agent?: string }, session: { agent: string }): string {
  return view.agent ?? session.agent;
}

/** A top-level session's permission level, from the latest event or else its summary. */
export function sessionLevel(
  view: { level?: PermissionLevel },
  session: { permissionLevel?: PermissionLevel },
): PermissionLevel {
  return view.level ?? session.permissionLevel ?? 'ask';
}

/** The agents a session can switch to, in Shift+Tab order: build, plan, then the rest by name. */
export function switchableAgents<A extends Pick<AgentSummary, 'name' | 'mode'>>(agents: A[]): A[] {
  const rank = (name: string) => (name === 'build' ? 0 : name === 'plan' ? 1 : 2);
  return agents
    .filter((a) => a.mode !== 'subagent')
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** The agent after `current` when cycling (Shift+Tab), or undefined when there's nowhere to go. */
export function nextAgent(
  agents: Pick<AgentSummary, 'name' | 'mode'>[],
  current: string,
): string | undefined {
  const order = switchableAgents(agents).map((a) => a.name);
  const next = order[(order.indexOf(current) + 1) % order.length];
  return next === current ? undefined : next;
}

/** `/agent` with no argument: the agents this session can switch to, the current one marked. */
export function formatAgentChoices(
  agents: Pick<AgentSummary, 'name' | 'mode' | 'description'>[],
  current: string | undefined,
): string {
  const list = switchableAgents(agents);
  const width = Math.max(...list.map((a) => a.name.length));
  return [
    ...list.map(
      (a) => `${a.name === current ? '●' : ' '} ${a.name.padEnd(width)}  ${a.description}`,
    ),
    '/agent <name> to switch; Shift+Tab cycles',
  ].join('\n');
}

/** `/permissions`: the permission level, the category levels, and every rule with where it came from. */
export function formatPermissions(p: PermissionsListResult): string {
  const row = (label: string, text: string) => `${label.padEnd(8)}${text}`;
  const lines = [
    ...(p.level ? [row('level', `${levelLabel(p.level)}: ${LEVEL_DESCRIPTIONS[p.level]}`)] : []),
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
