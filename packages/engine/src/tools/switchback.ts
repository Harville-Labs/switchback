/**
 * Tools for Switchback's own settings: which models there are, the
 * configuration in effect, and changing either. Changes always ask the user
 * (the permission gate's `mustAsk`), since they decide where calls go and
 * what they cost.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { SessionRoles } from '@switchback/protocol';
import { z } from 'zod';
import { redactConfig } from '../config.ts';
import { setConfigText } from '../config-write.ts';
import {
  defineTool,
  diffPreview,
  type ModelListing,
  type SwitchbackControls,
  type ToolContext,
  ToolError,
  truncate,
} from './tool.ts';

function controls(ctx: ToolContext): SwitchbackControls {
  if (!ctx.switchback) throw new ToolError("Switchback's settings aren't available here");
  return ctx.switchback;
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function describeModel(m: ModelListing, roles: SessionRoles): string {
  const cost =
    m.tier === 'local'
      ? 'free'
      : m.price
        ? `$${m.price.input}/$${m.price.output} per M tokens in/out`
        : 'price unknown';
  const uses = [
    roles.current.includes(m.alias) ? 'current' : '',
    roles.escalate.some((step) => step.includes(m.alias)) ? 'ladder' : '',
    roles.review.models.some((step) => step.includes(m.alias)) ? 'review' : '',
    roles.subagents === m.alias ? 'subagents' : '',
  ].filter(Boolean);
  return [
    `- ${m.alias}: ${m.model} on ${m.provider}`,
    m.tier,
    `${tokens(m.contextWindow)} context`,
    cost,
    ...(m.vision ? ['vision'] : []),
    ...(m.available ? [] : ['unreachable now']),
    ...(m.listed ? ['listed by its endpoint, not in a config file'] : []),
    ...(uses.length ? [`role: ${uses.join(', ')}`] : []),
  ].join(' · ');
}

const steps = (ladder: string[][]) => ladder.map((step) => step.join(' or ')).join(' → ');

/** A session's roles in words, for the models and set_roles tools. */
export function rolesText(roles: SessionRoles): string {
  const own = roles.overridden.length
    ? ` (changed in this session: ${roles.overridden.join(', ')})`
    : '';
  return [
    `Roles${own}:`,
    `- current (where prompts run): ${roles.current.join(', ') || 'none'}`,
    `- escalation ladder (hard turns climb it): ${steps(roles.escalate) || 'empty'}`,
    `- review: ${roles.review.mode}${roles.review.models.length ? `, by ${steps(roles.review.models)}` : ''}`,
    `- subagents: ${roles.subagents ?? 'routed like the session'}`,
  ].join('\n');
}

export const modelsTool = defineTool({
  name: 'models',
  description:
    "List Switchback's models (alias, tier, context, price, role in this session) and the escalation ladder. Pass an alias as task's `model`; prefer local models.",
  schema: z.object({}),
  permission: 'none',
  mutating: false,
  summarize: () => 'list models',
  async run(_input, ctx) {
    const c = controls(ctx);
    const roles = c.roles();
    const models = c.models();
    if (!models.length) return 'No models are configured. The user adds them with /init.';
    return `Models:\n${models.map((m) => describeModel(m, roles)).join('\n')}\n\n${rolesText(roles)}`;
  },
});

/** A dotted key (`routing.escalate`) or its segments, as a JSON path. */
const Key = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe('Dotted ("routing.escalate"), or segments when one has a dot (["models", "gpt-6.1"])');
const pathOf = (key: string | string[]) => (Array.isArray(key) ? key : key.split('.'));

function valueAt(config: unknown, path: string[]): unknown {
  let node: unknown = config;
  for (const segment of path) {
    if (!node || typeof node !== 'object' || !(segment in node))
      throw new ToolError(
        `no config key ${path.join('.')}${node && typeof node === 'object' ? `; under it: ${Object.keys(node).join(', ')}` : ''}`,
      );
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

export const configTool = defineTool({
  name: 'config',
  description:
    "Read Switchback's configuration in effect (all files merged, defaults filled, secrets hidden). Pass `key` for one section; omit it to list them. docs explains the keys.",
  schema: z.object({ key: Key.optional() }),
  permission: 'none',
  mutating: false,
  summarize: (i) => `read config${i.key ? `: ${pathOf(i.key).join('.')}` : ''}`,
  async run(input, ctx) {
    const c = controls(ctx);
    const config = redactConfig(c.config()) as Record<string, unknown>;
    if (!input.key)
      return `Sections: ${Object.keys(config).join(', ')}. Pass one as \`key\` to read it.`;
    const path = pathOf(input.key);
    const org = c.org();
    const dotted = path.join('.');
    const enforced = org?.enforcedKeys.filter((k) => k.startsWith(dotted) || dotted.startsWith(k));
    const note = enforced?.length
      ? `\n\nSet by ${org?.name}'s policy, so they can't be changed: ${enforced.join(', ')}`
      : '';
    return truncate(`${dotted} = ${JSON.stringify(valueAt(config, path), null, 2)}${note}`);
  },
});

const FILES = { user: 'user', project: 'project', local: 'projectLocal' } as const;

const SetConfigInput = z.object({
  key: Key,
  value: z
    .string()
    .optional()
    .describe('JSON ("0.5", "true", "[\\"a\\"]"); a bare word is a string. Omit to remove the key'),
  file: z
    .enum(['user', 'project', 'local'])
    .describe('user: all projects. project: this one, shared. local: this one, just this user'),
});
type SetConfigInput = z.infer<typeof SetConfigInput>;

function parseValue(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** The file and its text before and after the change, or a ToolError saying why it can't be made. */
function planChange(input: SetConfigInput, ctx: ToolContext) {
  const c = controls(ctx);
  if (!ctx.configFiles || !ctx.validate) throw new ToolError("config files aren't available here");
  const path = pathOf(input.key);
  const dotted = path.join('.');
  const org = c.org();
  const locked = org?.enforcedKeys.find((k) => k.startsWith(dotted) || dotted.startsWith(k));
  if (locked) throw new ToolError(`${org?.name}'s policy sets ${locked}; it can't be changed here`);
  const file = ctx.configFiles[FILES[input.file]];
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n';
  const after = setConfigText(before, path, parseValue(input.value));
  const problem = ctx.validate(file, after);
  if (problem) throw new ToolError(`that would make ${file} invalid: ${problem}`);
  return { file, before, after, dotted };
}

export const setConfigTool = defineTool({
  name: 'set_config',
  description:
    'Change one Switchback setting in a config file, keeping comments. The user approves the diff; it applies at once. Read it with config first. For models and the ladder, use set_roles.',
  schema: SetConfigInput,
  permission: 'edit',
  mutating: true,
  summarize: (i) =>
    `${i.value === undefined ? 'remove' : 'set'} ${pathOf(i.key).join('.')} in the ${i.file} config`,
  async preview(input, ctx) {
    const { file, before, after } = planChange(input, ctx);
    return { diff: diffPreview(file, before, after), proposed: { path: file, content: after } };
  },
  async run(input, ctx) {
    const { file, after, dotted } = planChange(input, ctx);
    let changed: string[];
    try {
      changed = controls(ctx).saveConfig(file, after);
    } catch (err) {
      throw new ToolError(`${(err as Error).message} Nothing was changed.`);
    }
    return `Saved ${dotted} to ${file}. ${changed.length ? `Changed in effect: ${changed.join(', ')}.` : 'The configuration in effect is the same (a session setting or another file may override it).'}`;
  },
});

const Step = z.array(z.string().min(1)).min(1);

export const setRolesTool = defineTool({
  name: 'set_roles',
  description:
    "Change this session's models: current (where prompts run), escalate (the ladder), review, subagents. Only what you pass changes; save: true makes it the default. The user approves. See aliases with models.",
  schema: z.object({
    current: Step.optional().describe('Aliases, first preferred'),
    escalate: z
      .array(Step)
      .optional()
      .describe('Lowest step first: [["a"], ["b", "c"]] climbs to a, then b or c. [] empties it'),
    review: z
      .object({ mode: z.enum(['off', 'auto']).optional(), models: z.array(Step).optional() })
      .optional(),
    subagents: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('An alias, or null to route them like the session'),
    save: z.boolean().optional().describe("Also save to the user's config"),
    reset: z.boolean().optional().describe("Drop this session's changes first"),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) =>
    [
      i.reset ? 'reset roles' : '',
      i.current ? `current: ${i.current.join(', ')}` : '',
      i.escalate ? `ladder: ${steps(i.escalate) || 'empty'}` : '',
      i.review
        ? `review: ${[i.review.mode, i.review.models && steps(i.review.models)].filter(Boolean).join(', ')}`
        : '',
      i.subagents !== undefined ? `subagents: ${i.subagents ?? 'routed'}` : '',
    ]
      .filter(Boolean)
      .join('; ') + (i.save ? ' (saved as the default)' : ' (this session)'),
  async run(input, ctx) {
    let result: SessionRoles & { savedTo?: string };
    try {
      result = controls(ctx).setRoles(input);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const { savedTo, ...roles } = result;
    return `${rolesText(roles)}${savedTo ? `\n\nSaved to ${savedTo} as the default for new sessions.` : ''}`;
  },
});
