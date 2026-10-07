/**
 * `switchback agents`: list agents.
 * `switchback agents new`: interview the user and write an agent file, optionally
 * with a system prompt drafted by their model. Every question has a flag, so it
 * also runs unattended.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rolesOfModel } from '@switchback/client';
import {
  AGENT_NAME,
  configRoles,
  projectPaths,
  renderAgentFile,
  switchbackPaths,
  tierOfModel,
} from '@switchback/engine';
import { type CommonFlags, createEngine } from '../bootstrap.ts';
import { bold, dim, green, Prompter, yellow } from '../prompt.ts';

export interface AgentNewFlags extends CommonFlags {
  yes: boolean;
  scope?: 'user' | 'project';
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  prompt?: string;
  budget?: number;
  isolation?: boolean;
}

const TOOL_PRESETS = [
  { label: 'Read-only', value: ['read', 'glob', 'grep'], hint: 'search and review' },
  {
    label: 'Read and edit',
    value: ['read', 'glob', 'grep', 'edit', 'write'],
    hint: 'changes files, no shell',
  },
  {
    label: 'Read, edit, and run commands',
    value: ['read', 'glob', 'grep', 'edit', 'write', 'bash'],
    hint: 'tests, builds',
  },
  { label: 'Everything', value: undefined, hint: 'all tools, including MCP tools and subagents' },
] as const;

export async function agents(sub: string | undefined, flags: AgentNewFlags): Promise<number> {
  if (sub === 'new') return newAgent(flags);
  if (sub && sub !== 'list') {
    process.stderr.write(`switchback agents: unknown subcommand "${sub}" (list, new)\n`);
    return 2;
  }
  const { engine, agentErrors } = createEngine(flags, 'deny');
  for (const a of engine.listAgents())
    process.stdout.write(
      `${a.name} [${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}${a.model ? `, ${a.model}` : ''}${a.budgetUsd !== undefined ? `, $${a.budgetUsd}` : ''}]: ${a.description}\n`,
    );
  for (const e of agentErrors) process.stderr.write(`skipped: ${e}\n`);
  return 0;
}

class AgentError extends Error {}

async function newAgent(flags: AgentNewFlags): Promise<number> {
  if (!flags.yes && !process.stdin.isTTY) {
    process.stderr.write('switchback agents new: not a terminal; pass --yes with flags\n');
    return 2;
  }
  const p = flags.yes ? undefined : new Prompter();
  try {
    return await interview(flags, p);
  } catch (err) {
    if (err instanceof AgentError) {
      process.stderr.write(`switchback agents new: ${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    p?.close();
  }
}

async function interview(flags: AgentNewFlags, p: Prompter | undefined): Promise<number> {
  const ask = async (flag: string | undefined, question: string, missing: string) => {
    const value = flag ?? (p ? await p.text(question) : undefined);
    if (!value) throw new AgentError(missing);
    return value;
  };
  if (p)
    console.log(
      `${bold('New agent')}\n${dim('An agent is a system prompt, a tool list, and a routing preference. The parent agent delegates to it with the task tool.')}\n`,
    );

  const name = await ask(flags.name, 'Name (lowercase, dashes)', 'pass --name');
  if (!AGENT_NAME.test(name))
    throw new AgentError('names use lowercase letters, digits, and dashes, starting with a letter');

  const scope =
    flags.scope ??
    (p
      ? await p.select('Where should it live?', [
          {
            label: 'This project',
            value: 'project' as const,
            hint: '.switchback/agents/, shared with the team',
          },
          {
            label: 'All my projects',
            value: 'user' as const,
            hint: '~/.switchback/agents/',
          },
        ])
      : 'project');
  const dir = scope === 'project' ? projectPaths(flags.cwd).agentsDir : switchbackPaths().agentsDir;
  const file = join(dir, `${name}.md`);
  if (existsSync(file) && !(p && (await p.confirm(`${file} exists. Replace it?`, false))))
    throw new AgentError(`${file} already exists`);

  const purpose = flags.prompt
    ? ''
    : await ask(flags.description, 'What does it do? (one sentence)', 'pass --description');
  if (p)
    console.log(
      dim(
        '\nThe description is what the parent reads to decide when to delegate. Say what it does and when to use it.',
      ),
    );
  const description =
    flags.description ??
    (p ? await p.text('Description', `${purpose.replace(/\.$/, '')}. Use when ...`) : undefined);
  if (!description || description.includes('Use when ...'))
    throw new AgentError('write a description that says when to use the agent');

  let tools: string[] | undefined;
  if (flags.tools !== undefined) {
    tools =
      flags.tools === 'all'
        ? undefined
        : flags.tools
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean);
  } else if (p) {
    type Preset = { tools: string[] | undefined } | 'custom';
    const preset = await p.select<Preset>('\nTools', [
      ...TOOL_PRESETS.map((t) => ({
        label: t.label,
        value: { tools: t.value ? [...t.value] : undefined },
        hint: t.hint,
      })),
      { label: 'Custom list', value: 'custom', hint: 'e.g. read, grep, mcp__github' },
    ]);
    tools =
      preset === 'custom'
        ? (await p.text('Tools, comma-separated'))
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : preset.tools;
  } else tools = ['read', 'glob', 'grep'];

  const { engine, loaded } = createEngine(flags, 'deny');
  const { config } = loaded;
  const roles = configRoles(config);
  const model =
    flags.model ??
    (p
      ? await p.select('\nWhich model should it run on?', [
          {
            label: 'Automatic',
            value: undefined,
            hint: 'routes like any turn: the start model, escalating when needed',
          },
          { label: 'Any local model', value: 'local', hint: 'never costs money' },
          { label: 'Any hosted model', value: 'remote', hint: 'the first in your roles' },
          ...Object.keys(config.models)
            // Tier keywords would read as tier pins, not these aliases.
            .filter((a) => !['local', 'remote'].includes(a))
            .map((a) => ({
              label: a,
              value: a,
              hint: [config.models[a]?.model, tierOfModel(config, a), ...rolesOfModel(a, roles)]
                .filter(Boolean)
                .join(' · '),
            })),
        ])
      : undefined);

  const free = model === 'local' || (model !== undefined && tierOfModel(config, model) === 'local');
  const budget =
    flags.budget ??
    (p && !free ? await p.number('Remote budget per run in USD (empty for none)') : undefined);
  const edits = !tools || tools.some((t) => t === 'edit' || t === 'write' || t === 'bash');
  const isolation =
    flags.isolation ??
    (p && edits
      ? await p.confirm(
          'Work in its own git worktree, so its edits never touch your working tree?',
          false,
        )
      : false);

  let prompt = flags.prompt;
  if (!prompt && p && (await p.confirm('\nDraft the system prompt with your model?', true))) {
    console.log(dim('  Drafting…'));
    try {
      prompt = await engine.draftAgentPrompt({
        name,
        purpose,
        description,
        ...(tools ? { tools } : {}),
      });
      console.log(`\n${prompt}\n`);
      if (!(await p.confirm('Use this prompt? (you can edit the file afterwards)', true)))
        prompt = undefined;
    } catch (err) {
      console.log(yellow(`  Could not draft a prompt: ${(err as Error).message}`));
    }
  }
  prompt ??= `You are ${name}, a subagent. ${purpose || description}\n\nWork independently from the brief you are given; you cannot see the parent's conversation. Finish with a concise report of what you found or changed, with file paths.`;
  await engine.shutdown();

  const text = renderAgentFile({
    name,
    description,
    prompt,
    ...(tools ? { tools } : {}),
    ...(model ? { model } : {}),
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
    ...(isolation ? { isolation: 'worktree' as const } : {}),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  console.log(
    `${green('✓')} Wrote ${file}\n${dim(`It's available now as "${name}" (in /agents, and to the task tool). Edit the file to refine the prompt.`)}`,
  );
  return 0;
}
