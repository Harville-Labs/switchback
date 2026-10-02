/**
 * `switchback init`: guided configuration. Detects local model servers, asks
 * which models to use (local, hosted, or both), then which model does what
 * (ADR 0015), and writes a config file. Every question has a flag so setup can
 * also run unattended (`--yes`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { formatRoles, formatSteps } from '@switchback/client';
import {
  buildSetupConfig,
  catalogFor,
  type DetectedServer,
  defaultRoles,
  detectLocalServers,
  type LocalAnswer,
  type PlannedModel,
  parseJsonc,
  planModels,
  projectPaths,
  REMOTE_KINDS,
  REMOTE_PROVIDERS,
  type RemoteAnswer,
  type RemoteKind,
  type Roles,
  type SetupAnswers,
  switchbackPaths,
  writeConfigLayer,
} from '@switchback/engine';
import type { SessionRoles } from '@switchback/protocol';
import {
  CATALOG,
  CREDENTIAL_ENV,
  type HostedProviderKind,
  hasAnthropicCredentials,
} from '@switchback/providers';
import { bold, dim, green, Prompter, yellow } from '../prompt.ts';
import { doctor } from './doctor.ts';
import { setTelemetry, TELEMETRY_PROMPT } from './telemetry.ts';

export interface InitFlags {
  cwd: string;
  yes: boolean;
  scope?: 'user' | 'project';
  /** Extra server URLs to probe. */
  localUrls: string[];
  /** Local models in order of preference; `contextWindows` pairs with them by position. */
  localModels: string[];
  contextWindows: number[];
  /** Roles by alias or model ID; defaults from `defaultRoles`. `start` is a chain. */
  start?: string[];
  /** Escalation steps in order; each an alias, or a comma-separated chain. */
  escalate?: string[];
  /** `off`, `ladder` (the escalation ladder), or comma-separated reviewers in order. */
  reviewers?: string;
  /** Default model for subagents. */
  subagentModel?: string;
  noLocal: boolean;
  /** Remote providers in order of preference; `remoteModels` pairs with them by position. */
  remotes: (RemoteKind | 'none')[];
  remoteModels: string[];
  /** openai-compatible remote only. */
  remoteUrl?: string;
  remoteKeyEnv?: string;
  remoteContextWindow?: number;
  region?: string;
  profile?: string;
  projectId?: string;
  /** Claude Platform on AWS. */
  workspaceId?: string;
  /** Microsoft Foundry resource name. */
  resource?: string;
  policy?: 'auto' | 'ask' | 'off';
  dailyBudget?: number;
  monthlyBudget?: number;
  /** Anonymous usage statistics; always written to the user config. */
  telemetry?: boolean;
}

class SetupError extends Error {}

export async function init(flags: InitFlags): Promise<number> {
  if (!flags.yes && !process.stdin.isTTY) {
    process.stderr.write(
      'switchback init: not a terminal; pass --yes with flags (see `switchback --help`)\n',
    );
    return 2;
  }
  const p = flags.yes ? undefined : new Prompter();
  try {
    return await run(flags, p);
  } catch (err) {
    if (err instanceof SetupError) {
      process.stderr.write(`switchback init: ${err.message}\n`);
      return 2;
    }
    throw err;
  } finally {
    p?.close();
  }
}

async function run(flags: InitFlags, p: Prompter | undefined): Promise<number> {
  if (p) {
    console.log(
      `${bold('Switchback setup')}\n${dim('Pick the models you want, local, hosted, or both; then choose which one starts, which ones it escalates to, and who reviews.')}\n`,
    );
  }

  const scope =
    flags.scope ??
    (p
      ? await p.select('Where should this configuration live?', [
          {
            label: 'User config',
            value: 'user' as const,
            hint: 'this machine, all projects (recommended for model servers)',
          },
          {
            label: 'Project config',
            value: 'project' as const,
            hint: '.switchback/config.json in this workspace',
          },
        ])
      : 'user');
  const file = scope === 'user' ? switchbackPaths().configFile : projectPaths(flags.cwd).configFile;
  if (
    existsSync(file) &&
    p &&
    !(await p.confirm(`\n${file} exists. Update it? A backup is kept at .bak.`))
  ) {
    console.log('Nothing changed.');
    return 0;
  }

  const locals = await chooseLocals(flags, p);
  const remotes = await chooseRemotes(flags, p);
  if (!locals.length && !remotes.length)
    throw new SetupError('pick at least one model, local or hosted');

  const plan = planModels({ locals, remotes });
  const roles = await chooseRoles(flags, p, plan);
  const tierOf = (alias: string) => plan.find((m) => m.alias === alias)?.tier;
  const escalatesRemote = roles.escalate.flat().some((a) => tierOf(a) === 'remote');
  const usesRemote =
    escalatesRemote ||
    [
      ...roles.start,
      roles.subagents ?? '',
      ...(Array.isArray(roles.review) ? roles.review.flat() : []),
    ].some((a) => tierOf(a) === 'remote');

  const escalationPolicy =
    flags.policy ??
    (p && escalatesRemote
      ? await p.select('\nWhen a model struggles and the next step is a hosted model:', [
          {
            label: 'Escalate automatically',
            value: 'auto' as const,
            hint: 'shows the reason each time',
          },
          { label: 'Ask me first', value: 'ask' as const, hint: 'local steps never ask' },
          {
            label: 'Never escalate',
            value: 'off' as const,
            hint: 'only context overflow and outages move up',
          },
        ])
      : 'auto');

  let budget: SetupAnswers['budget'];
  if (flags.dailyBudget || flags.monthlyBudget) {
    budget = {
      ...(flags.dailyBudget ? { dailyUsd: flags.dailyBudget } : {}),
      ...(flags.monthlyBudget ? { monthlyUsd: flags.monthlyBudget } : {}),
    };
  } else if (p && usesRemote) {
    console.log(
      dim('\nBudgets keep calls on local models once reached. Leave empty for no limit.'),
    );
    const dailyUsd = await p.number('Daily remote budget in USD');
    const monthlyUsd = await p.number('Monthly remote budget in USD');
    if (dailyUsd || monthlyUsd)
      budget = { ...(dailyUsd ? { dailyUsd } : {}), ...(monthlyUsd ? { monthlyUsd } : {}) };
  }

  const answers: SetupAnswers = {
    locals,
    remotes,
    roles,
    escalationPolicy,
    ...(budget ? { budget } : {}),
  };
  const layer = buildSetupConfig(answers);

  if (p) {
    console.log(
      `\n${bold('Configuration to write')} ${dim(file)}\n${JSON.stringify(layer, null, 2)}\n`,
    );
    if (!(await p.confirm('Write it?'))) {
      console.log('Nothing changed.');
      return 0;
    }
  }
  const result = writeConfigLayer(file, layer);
  console.log(
    `${green('✓')} Wrote ${result.file}${result.backup ? dim(` (previous version: ${result.backup})`) : ''}\n`,
  );
  const share =
    flags.telemetry ??
    (p && !telemetryChosen()
      ? await p.confirm(
          `${TELEMETRY_PROMPT}\n${dim('  Details: docs/telemetry.md. Change it any time with `switchback telemetry on|off`.')}\n `,
          false,
        )
      : undefined);
  if (share !== undefined) {
    setTelemetry(share);
    console.log(`${green('✓')} Telemetry ${share ? 'on. Thank you' : 'off'}.\n`);
  }
  await doctor({ cwd: flags.cwd, mock: false });
  return 0;
}

/** Whether the user has answered before (either way): their config says. */
function telemetryChosen(): boolean {
  const file = switchbackPaths().configFile;
  if (!existsSync(file)) return false;
  try {
    const cfg = parseJsonc(readFileSync(file, 'utf8')) as { telemetry?: { enabled?: unknown } };
    return typeof cfg.telemetry?.enabled === 'boolean';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** A role reference (`alias` or model ID) to the alias setup gives that model. */
function resolveAlias(plan: PlannedModel[], ref: string, flag: string): string {
  const hit = plan.find((m) => m.alias === ref) ?? plan.find((m) => m.model === ref);
  if (!hit)
    throw new SetupError(
      `${flag} "${ref}" isn't one of the chosen models (${plan.map((m) => m.alias).join(', ')})`,
    );
  return hit.alias;
}

/** Which model does what: flags unattended, else defaults the user can change. */
async function chooseRoles(
  flags: InitFlags,
  p: Prompter | undefined,
  plan: PlannedModel[],
): Promise<Roles> {
  const roles = defaultRoles(plan);
  const chain = (v: string, flag: string) =>
    v.split(',').map((ref) => resolveAlias(plan, ref.trim(), flag));
  if (flags.start?.length) roles.start = flags.start.flatMap((v) => chain(v, '--start'));
  if (flags.escalate) roles.escalate = flags.escalate.map((v) => chain(v, '--escalate'));
  if (flags.reviewers)
    roles.review =
      flags.reviewers === 'off' || flags.reviewers === 'ladder'
        ? flags.reviewers
        : chain(flags.reviewers, '--reviewers').map((alias) => [alias]);
  if (flags.subagentModel)
    roles.subagents = resolveAlias(plan, flags.subagentModel, '--subagent-model');
  if (!p) return roles;

  // Shown exactly as `/roles` and `switchback doctor` show them.
  const models = plan.map((m) => ({
    alias: m.alias,
    ref: { provider: m.where, model: m.model },
    tier: m.tier,
  }));
  const asSession = (): SessionRoles => ({
    start: roles.start,
    escalate: roles.escalate,
    review:
      roles.review === 'off'
        ? { mode: 'off', models: [] }
        : { mode: 'auto', models: roles.review === 'ladder' ? [] : roles.review },
    ...(roles.subagents ? { subagents: roles.subagents } : {}),
    overridden: [],
  });
  for (;;) {
    console.log(`\n${bold('Which model does what')}`);
    for (const line of formatRoles(asSession(), models).split('\n')) console.log(`  ${line}`);
    const action = await p.select('', [
      { label: 'Looks good', value: 'done' as const },
      { label: 'Change where turns start', value: 'start' as const },
      { label: 'Change the escalation ladder', value: 'escalate' as const },
      { label: 'Change who reviews edits', value: 'review' as const },
      { label: 'Change the subagent model', value: 'subagents' as const },
    ]);
    if (action === 'done') return roles;
    if (action === 'start') {
      const first = await pickModel(p, plan, 'Which model should turns start on?', []);
      if (!first) continue;
      roles.start = [first];
      for (;;) {
        const backup = await pickModel(
          p,
          plan,
          'Add a backup start model? It takes over when the first is down or a prompt is too big for it.',
          roles.start,
          'No more',
        );
        if (!backup) break;
        roles.start.push(backup);
      }
      roles.escalate = roles.escalate.filter((step) => !step.some((a) => roles.start.includes(a)));
    }
    if (action === 'escalate') {
      roles.escalate = [];
      for (;;) {
        const next = await pickModel(
          p,
          plan,
          roles.escalate.length
            ? 'If that one struggles too, escalate to:'
            : 'When the start model struggles, escalate to:',
          [...roles.start, ...roles.escalate.flat()],
          roles.escalate.length ? 'Nothing more' : 'Nothing: no escalation',
        );
        if (!next) break;
        roles.escalate.push([next]);
      }
    }
    if (action === 'review') {
      const how = await p.select('Review edits automatically?', [
        { label: 'No', value: 'off' as const },
        ...(roles.escalate.length
          ? [
              {
                label: `Yes, with the escalation ladder (${formatSteps(roles.escalate)})`,
                value: 'ladder' as const,
                hint: 'the first reviews; the next steps in when its findings stand',
              },
            ]
          : []),
        { label: 'Yes, with models I choose', value: 'choose' as const },
      ]);
      if (how !== 'choose') roles.review = how;
      else {
        const reviewers: string[][] = [];
        for (;;) {
          const next = await pickModel(
            p,
            plan,
            reviewers.length
              ? "If that reviewer's findings still stand after a fix, the next reviewer:"
              : 'Who reviews first? (A model never reviews its own edits.)',
            reviewers.flat(),
            reviewers.length ? 'No more' : 'Cancel',
          );
          if (!next) break;
          reviewers.push([next]);
        }
        if (reviewers.length) roles.review = reviewers;
      }
    }
    if (action === 'subagents') {
      const pick = await p.select('Which model should subagents use when their agent names none?', [
        { label: 'Normal routing', value: '' },
        ...plan.map((m) => ({ label: m.alias, value: m.alias, hint: `${m.model} · ${m.tier}` })),
      ]);
      roles.subagents = pick || undefined;
    }
  }
}

/** One model from the plan, leaving out `taken`; undefined for the "none" choice. */
async function pickModel(
  p: Prompter,
  plan: PlannedModel[],
  question: string,
  taken: string[],
  none = 'Cancel',
): Promise<string | undefined> {
  const options = plan
    .filter((m) => !taken.includes(m.alias))
    .map((m) => ({
      label: m.alias,
      value: m.alias,
      hint: [
        m.tier,
        m.where,
        m.contextWindow ? `ctx ${m.contextWindow.toLocaleString('en-US')}` : undefined,
        m.inputPrice !== undefined
          ? `$${m.inputPrice}/M in`
          : m.tier === 'local'
            ? 'free'
            : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
  const pick = await p.select(`\n${question}`, [...options, { label: none, value: '' }]);
  return pick || undefined;
}

// ---------------------------------------------------------------------------

type Pick = { server: DetectedServer; model: DetectedServer['models'][number] } | 'manual' | 'done';

const ADD_LOCAL =
  'Add another local model? (A bigger one to escalate to, a backup, or a reviewer: you choose roles next.)';

async function chooseLocals(flags: InitFlags, p: Prompter | undefined): Promise<LocalAnswer[]> {
  if (flags.noLocal) return [];
  if (p)
    console.log(
      `\n${bold('Local models')}\n${dim('Looking for model servers on this machine...')}`,
    );
  const servers = await detectLocalServers({ extra: flags.localUrls });

  // Unattended: models must be named; each server is found or given.
  if (!p) {
    if (!flags.localModels.length) {
      if (flags.remotes.some((r) => r !== 'none')) return [];
      throw new SetupError(
        'pass --local-model (and --local-url if not auto-detected), or --no-local',
      );
    }
    const urls = flags.localUrls.map(normalizeUrl);
    return flags.localModels.map((name, i) => {
      const server =
        servers.find((s) => urls[i] === s.baseUrl && s.models.some((m) => m.id === name)) ??
        servers.find((s) => s.models.some((m) => m.id === name));
      const baseUrl = server?.baseUrl ?? urls[i] ?? urls[0];
      if (!baseUrl) throw new SetupError(`no running server has "${name}"; pass --local-url`);
      const detected = server?.models.find((m) => m.id === name);
      const contextWindow = flags.contextWindows[i] ?? detected?.contextWindow;
      if (!contextWindow)
        throw new SetupError(
          `could not detect the context window of ${name}; pass --context-window`,
        );
      return {
        providerId: server?.kind === 'openai-compatible' || !server ? 'local-server' : server.kind,
        baseUrl,
        model: name,
        contextWindow,
      };
    });
  }

  const options: { label: string; value: Pick; hint?: string }[] = [];
  for (const server of servers) {
    for (const model of server.models) {
      const hints = [
        model.contextWindow ? `ctx ${model.contextWindow.toLocaleString('en-US')}` : undefined,
        model.tools === true ? 'tools ✓' : model.tools === false ? 'no tool calling' : undefined,
      ].filter(Boolean);
      options.push({
        label: `${server.label} · ${model.id}`,
        value: { server, model },
        hint: hints.join(' · '),
      });
    }
  }
  if (servers.length === 0) {
    console.log(
      yellow('No local model server found.') +
        dim(
          ' Install one (Ollama: https://ollama.com, LM Studio, llama.cpp) and pull a model with tool-calling support, or enter a server URL.',
        ),
    );
  } else if (options.length === 0) {
    console.log(
      yellow(
        `Found ${servers.map((s) => s.label).join(', ')} but no models. Pull a model first (e.g. \`ollama pull <model>\`).`,
      ),
    );
  }

  const chosen: LocalAnswer[] = [];
  for (;;) {
    const remaining = options.filter(
      (o) =>
        typeof o.value !== 'object' ||
        !chosen.some((c) => {
          const v = o.value as Exclude<Pick, string>;
          return c.baseUrl === v.server.baseUrl && c.model === v.model.id;
        }),
    );
    // Prefer a model that reports tool support.
    const preferred = Math.max(
      0,
      remaining.findIndex((o) => typeof o.value === 'object' && o.value.model.tools === true),
    );
    const choices = [
      ...remaining,
      { label: 'Enter a server URL and model manually', value: 'manual' as const },
      {
        label: chosen.length ? 'Done' : 'Skip: no local models (hosted only)',
        value: 'done' as const,
      },
    ];
    const pick = await p.select(
      chosen.length ? '\nWhich other local model?' : `\n${bold('Local models')}: which one first?`,
      choices,
      remaining.length ? preferred : choices.length - 2,
    );
    if (pick === 'done') break;
    chosen.push(pick === 'manual' ? await manualLocal(flags, p) : await detectedLocal(pick, p));
    if (!(await p.confirm(`\n${ADD_LOCAL}`, false))) break;
  }

  return chosen;
}

async function manualLocal(flags: InitFlags, p: Prompter): Promise<LocalAnswer> {
  const baseUrl = normalizeUrl(
    await p.text('Server base URL', flags.localUrls[0] ?? 'http://localhost:11434/v1'),
  );
  const [probe] = await detectLocalServers({ extra: [baseUrl] }).then((s) =>
    s.filter((x) => x.baseUrl === baseUrl),
  );
  if (probe?.models.length)
    console.log(dim(`  Models on this server: ${probe.models.map((m) => m.id).join(', ')}`));
  else console.log(yellow('  Could not list models at that URL; continuing anyway.'));
  const model = await p.text('Model name', probe?.models[0]?.id);
  if (!model) throw new SetupError('a model name is required');
  const contextWindow =
    (await p.number('Context window (tokens) the server loads', 32_768)) ?? 32_768;
  const apiKeyEnv = await p.text('Environment variable holding an API key (leave empty for none)');
  return {
    providerId: 'local-server',
    baseUrl,
    model,
    contextWindow,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  };
}

async function detectedLocal(
  { server, model }: Exclude<Pick, string>,
  p: Prompter,
): Promise<LocalAnswer> {
  if (model.tools === false) {
    console.log(
      yellow(
        `  ${model.id} doesn't report tool-calling support. Switchback will escalate often with it.`,
      ),
    );
  }
  if (server.note) console.log(dim(`  ${server.note}`));
  const suggested = model.contextWindow ?? 32_768;
  const contextWindow =
    (await p.number(
      `Context window (tokens) ${dim(model.maxContext ? `model max ${model.maxContext.toLocaleString('en-US')}` : 'the server loads')}`,
      suggested,
    )) ?? suggested;
  return {
    providerId: server.kind === 'openai-compatible' ? 'local-server' : server.kind,
    baseUrl: server.baseUrl,
    model: model.id,
    contextWindow,
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

// ---------------------------------------------------------------------------
// Remote
// ---------------------------------------------------------------------------

const remoteLabel = (kind: RemoteKind) => {
  const { name, detail } = REMOTE_PROVIDERS[kind];
  return detail ? `${name} (${detail})` : name;
};

function credentialHint(kind: RemoteKind): string {
  switch (kind) {
    case 'anthropic':
      return hasAnthropicCredentials()
        ? 'credentials found'
        : 'needs ANTHROPIC_API_KEY or `ant auth login`';
    case 'openai':
    case 'deepseek':
    case 'gemini': {
      const env = CREDENTIAL_ENV[kind] as string;
      return process.env[env] ? 'credentials found' : `needs ${env}`;
    }
    case 'bedrock':
      return 'AWS credentials';
    case 'anthropic-aws':
      return 'AWS credentials and a Claude workspace ID';
    case 'foundry':
      return process.env.ANTHROPIC_FOUNDRY_API_KEY
        ? 'credentials found'
        : 'needs ANTHROPIC_FOUNDRY_API_KEY';
    case 'vertex':
      return 'gcloud application-default credentials';
    case 'openai-compatible':
      return 'base URL and API key';
  }
}

async function chooseRemotes(flags: InitFlags, p: Prompter | undefined): Promise<RemoteAnswer[]> {
  if (!p) {
    if (!flags.remotes.length)
      throw new SetupError(`pass --remote (${[...REMOTE_KINDS, 'none'].join(', ')})`);
    const kinds = flags.remotes.filter((k): k is RemoteKind => k !== 'none');
    const out: RemoteAnswer[] = [];
    for (const [i, kind] of kinds.entries())
      out.push(await chooseRemote(kind, flags.remoteModels[i], flags, undefined));
    return out;
  }
  const chosen: RemoteAnswer[] = [];
  for (;;) {
    const kind: RemoteKind | 'none' = await p.select(
      chosen.length
        ? '\nWhich provider for the next hosted model?'
        : `\n${bold('Hosted models')}\nWhich provider?`,
      [
        ...REMOTE_KINDS.map((k) => ({
          label: remoteLabel(k),
          value: k,
          hint: credentialHint(k),
        })),
        { label: chosen.length ? 'Done' : 'None: local models only', value: 'none' as const },
      ],
    );
    if (kind === 'none') break;
    chosen.push(await chooseRemote(kind, undefined, flags, p));
    if (!(await p.confirm('\nAdd another hosted model? (Same provider or another.)', false))) break;
  }
  return chosen;
}

async function chooseRemote(
  kind: RemoteKind,
  modelFlag: string | undefined,
  flags: InitFlags,
  p: Prompter | undefined,
): Promise<RemoteAnswer> {
  const env = process.env;

  if (kind === 'openai-compatible') {
    const baseUrl =
      flags.remoteUrl ??
      (p ? await p.text('API base URL (e.g. https://openrouter.ai/api/v1)') : undefined);
    const model = modelFlag ?? (p ? await p.text('Model ID') : undefined);
    if (!baseUrl || !model)
      throw new SetupError('--remote-url and --remote-model are required for openai-compatible');
    const apiKeyEnv =
      flags.remoteKeyEnv ??
      (p ? await p.text('Environment variable holding the API key') : undefined);
    const contextWindow =
      flags.remoteContextWindow ??
      (p ? await p.number('Context window (tokens)', 128_000) : undefined) ??
      128_000;
    return {
      kind,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      contextWindow,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    };
  }

  const catalog = CATALOG[catalogFor(kind) as HostedProviderKind];
  const model =
    modelFlag ??
    (p
      ? await p.select(
          'Which model?',
          catalog.models.map((m) => ({
            label: m.label,
            value: m.id,
            hint: `${m.size}; $${m.price.input} / $${m.price.output} per M tokens${m.note ? ` (${m.note})` : ''}`,
          })),
        )
      : catalog.models[0]?.id);
  if (!model || !catalog.models.some((m) => m.id === model)) {
    throw new SetupError(
      `--remote-model must be one of ${catalog.models.map((m) => m.id).join(', ')}`,
    );
  }
  const hint = credentialHint(kind);
  if (hint.startsWith('needs'))
    console.log(yellow(`  ${remoteLabel(kind)} ${hint} before Switchback can use it.`));

  switch (kind) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
    case 'gemini':
      return { kind, model };
    case 'bedrock': {
      const region =
        flags.region ??
        (p
          ? await p.text('AWS region', env.AWS_REGION ?? 'us-east-1')
          : (env.AWS_REGION ?? 'us-east-1'));
      const profile =
        flags.profile ??
        (p
          ? await p.text('AWS profile (leave empty for the default chain)', env.AWS_PROFILE)
          : env.AWS_PROFILE);
      if (p)
        console.log(
          dim(
            '  Bedrock bills differently from the Anthropic API; set models.<alias>.price for accurate savings.',
          ),
        );
      return { kind, model, region, ...(profile ? { profile } : {}) };
    }
    case 'vertex': {
      const fallbackProject = env.GOOGLE_CLOUD_PROJECT ?? env.CLOUDSDK_CORE_PROJECT;
      const projectId =
        flags.projectId ?? (p ? await p.text('GCP project ID', fallbackProject) : fallbackProject);
      if (!projectId) throw new SetupError('Vertex AI needs a project ID (--project-id)');
      const region = flags.region ?? (p ? await p.text('Region', 'global') : 'global');
      return { kind, model, projectId, region };
    }
    case 'anthropic-aws': {
      const region =
        flags.region ?? (p ? await p.text('AWS region', env.AWS_REGION) : env.AWS_REGION);
      const workspaceId =
        flags.workspaceId ??
        (p
          ? await p.text('Claude workspace ID', env.ANTHROPIC_AWS_WORKSPACE_ID)
          : env.ANTHROPIC_AWS_WORKSPACE_ID);
      if (!region || !workspaceId)
        throw new SetupError('Claude Platform on AWS needs --region and --workspace-id');
      const profile =
        flags.profile ??
        (p
          ? await p.text('AWS profile (leave empty for the default chain)', env.AWS_PROFILE)
          : env.AWS_PROFILE);
      return { kind, model, region, workspaceId, ...(profile ? { profile } : {}) };
    }
    case 'foundry': {
      const resource =
        flags.resource ??
        (p
          ? await p.text('Foundry resource name', env.ANTHROPIC_FOUNDRY_RESOURCE)
          : env.ANTHROPIC_FOUNDRY_RESOURCE);
      if (!resource) throw new SetupError('Microsoft Foundry needs --resource');
      return { kind, model, resource };
    }
  }
}

/** First-run prompt before the TUI opens. */
export async function offerSetup(cwd: string): Promise<number> {
  const p = new Prompter();
  const yes = await p.confirm(
    `${bold('No Switchback configuration found.')} Set up your models now?`,
  );
  p.close();
  if (!yes) {
    console.log(
      dim('Continuing without configured models. Run `switchback init` any time to choose them.\n'),
    );
    return 0;
  }
  return init({
    cwd,
    yes: false,
    noLocal: false,
    localUrls: [],
    localModels: [],
    contextWindows: [],
    remotes: [],
    remoteModels: [],
  });
}
