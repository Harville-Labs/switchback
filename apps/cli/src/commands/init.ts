/**
 * `harness init`: guided configuration. Detects local model servers, asks
 * which local and remote models to use, and writes a config file. Every
 * question has a flag so setup can also run unattended (`--yes`).
 */
import { existsSync } from 'node:fs';
import {
  buildSetupConfig,
  type DetectedServer,
  detectLocalServers,
  harnessPaths,
  projectPaths,
  REMOTE_MODELS,
  type SetupAnswers,
  writeConfigLayer,
} from '@harness/engine';
import { hasAnthropicCredentials } from '@harness/providers';
import { bold, dim, green, Prompter, yellow } from '../prompt.ts';
import { doctor } from './doctor.ts';

export interface InitFlags {
  cwd: string;
  yes: boolean;
  scope?: 'user' | 'project';
  localUrl?: string;
  localModel?: string;
  contextWindow?: number;
  noLocal: boolean;
  remote?: 'anthropic' | 'bedrock' | 'vertex' | 'none';
  remoteModel?: string;
  region?: string;
  profile?: string;
  projectId?: string;
  policy?: 'auto' | 'ask' | 'off';
  dailyBudget?: number;
  monthlyBudget?: number;
}

class SetupError extends Error {}

export async function init(flags: InitFlags): Promise<number> {
  if (!flags.yes && !process.stdin.isTTY) {
    process.stderr.write(
      'harness init: not a terminal; pass --yes with flags (see `harness --help`)\n',
    );
    return 2;
  }
  const p = flags.yes ? undefined : new Prompter();
  try {
    return await run(flags, p);
  } catch (err) {
    if (err instanceof SetupError) {
      process.stderr.write(`harness init: ${err.message}\n`);
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
      `${bold('Harness setup')}\n${dim('Configure the local model you run and the remote model Harness escalates to.')}\n`,
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
            hint: '.harness/config.json in this workspace',
          },
        ])
      : 'user');
  const file = scope === 'user' ? harnessPaths().configFile : projectPaths(flags.cwd).configFile;
  if (
    existsSync(file) &&
    p &&
    !(await p.confirm(`\n${file} exists. Update it? A backup is kept at .bak.`))
  ) {
    console.log('Nothing changed.');
    return 0;
  }

  const local = await chooseLocal(flags, p);
  const remote = await chooseRemote(flags, p);
  if (!local && remote.kind === 'none')
    throw new SetupError('configure a local model, a remote provider, or both');

  const escalationPolicy =
    flags.policy ??
    (p && local && remote.kind !== 'none'
      ? await p.select('\nWhen the local model struggles, escalate to remote:', [
          { label: 'Automatically', value: 'auto' as const, hint: 'shows the reason each time' },
          { label: 'Ask me first', value: 'ask' as const },
          {
            label: 'Never',
            value: 'off' as const,
            hint: 'only context overflow and outages go remote',
          },
        ])
      : 'auto');

  let budget: SetupAnswers['budget'];
  if (flags.dailyBudget || flags.monthlyBudget) {
    budget = {
      ...(flags.dailyBudget ? { dailyUsd: flags.dailyBudget } : {}),
      ...(flags.monthlyBudget ? { monthlyUsd: flags.monthlyBudget } : {}),
    };
  } else if (p && remote.kind !== 'none') {
    console.log(
      dim('\nBudgets keep automatic escalations local once reached. Leave empty for no limit.'),
    );
    const dailyUsd = await p.number('Daily remote budget in USD');
    const monthlyUsd = await p.number('Monthly remote budget in USD');
    if (dailyUsd || monthlyUsd)
      budget = { ...(dailyUsd ? { dailyUsd } : {}), ...(monthlyUsd ? { monthlyUsd } : {}) };
  }

  const answers: SetupAnswers = {
    ...(local ? { local } : {}),
    remote,
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
  await doctor({ cwd: flags.cwd, mock: false });
  return 0;
}

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

type Pick = { server: DetectedServer; model: DetectedServer['models'][number] } | 'manual' | 'skip';

async function chooseLocal(
  flags: InitFlags,
  p: Prompter | undefined,
): Promise<SetupAnswers['local']> {
  if (flags.noLocal) return undefined;
  if (p)
    console.log(`\n${bold('Local model')}\n${dim('Looking for model servers on this machine...')}`);
  const servers = await detectLocalServers(flags.localUrl ? { extra: [flags.localUrl] } : {});

  // Unattended: the model must be named; the server is found or given.
  if (!p) {
    if (!flags.localModel) {
      if (flags.remote && flags.remote !== 'none') return undefined;
      throw new SetupError(
        'pass --local-model (and --local-url if not auto-detected), or --no-local',
      );
    }
    const server =
      servers.find((s) => flags.localUrl && s.baseUrl === normalizeUrl(flags.localUrl)) ??
      servers.find((s) => s.models.some((m) => m.id === flags.localModel));
    const baseUrl = server?.baseUrl ?? (flags.localUrl ? normalizeUrl(flags.localUrl) : undefined);
    if (!baseUrl)
      throw new SetupError(`no running server has "${flags.localModel}"; pass --local-url`);
    const detected = server?.models.find((m) => m.id === flags.localModel);
    const contextWindow = flags.contextWindow ?? detected?.contextWindow;
    if (!contextWindow)
      throw new SetupError('could not detect the context window; pass --context-window');
    return {
      providerId: server?.kind === 'openai-compatible' || !server ? 'local-server' : server.kind,
      baseUrl,
      model: flags.localModel,
      contextWindow,
    };
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
  // Prefer a model that reports tool support.
  const preferred = Math.max(
    0,
    options.findIndex((o) => typeof o.value === 'object' && o.value.model.tools === true),
  );
  options.push({ label: 'Enter a server URL and model manually', value: 'manual' });
  options.push({ label: 'Skip: no local model (remote only)', value: 'skip' });
  const pick = await p.select(
    '\nWhich local model should Harness use?',
    options,
    options.length > 2 ? preferred : options.length - 2,
  );
  if (pick === 'skip') return undefined;

  if (pick === 'manual') {
    const baseUrl = normalizeUrl(
      await p.text('Server base URL', flags.localUrl ?? 'http://localhost:11434/v1'),
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
    const apiKeyEnv = await p.text(
      'Environment variable holding an API key (leave empty for none)',
    );
    return {
      providerId: 'local-server',
      baseUrl,
      model,
      contextWindow,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
    };
  }

  const { server, model } = pick;
  if (model.tools === false) {
    console.log(
      yellow(
        `  ${model.id} doesn't report tool-calling support. Harness will escalate often with it.`,
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

async function chooseRemote(
  flags: InitFlags,
  p: Prompter | undefined,
): Promise<SetupAnswers['remote']> {
  const env = process.env;
  const hasKey = hasAnthropicCredentials();
  const kind =
    flags.remote ??
    (p
      ? await p.select(`\n${bold('Remote model')}\nWhere should escalated turns run?`, [
          {
            label: 'Claude via the Anthropic API',
            value: 'anthropic' as const,
            hint: hasKey ? 'credentials found' : 'needs ANTHROPIC_API_KEY or `ant auth login`',
          },
          { label: 'Claude on Amazon Bedrock', value: 'bedrock' as const, hint: 'AWS credentials' },
          {
            label: 'Claude on Google Vertex AI',
            value: 'vertex' as const,
            hint: 'gcloud application-default credentials',
          },
          { label: 'None: local only', value: 'none' as const },
        ])
      : 'anthropic');
  if (kind === 'none') return { kind };

  const model =
    flags.remoteModel ??
    (p
      ? await p.select('Model for escalated turns:', [
          {
            label: 'Claude Opus 5',
            value: 'claude-opus-5',
            hint: 'most capable; $5 / $25 per M tokens',
          },
          {
            label: 'Claude Sonnet 5',
            value: 'claude-sonnet-5',
            hint: 'balanced; $2 / $10 per M tokens',
          },
          {
            label: 'Claude Haiku 4.5',
            value: 'claude-haiku-4-5',
            hint: 'fastest; $1 / $5 per M tokens',
          },
        ])
      : 'claude-opus-5');
  if (!(REMOTE_MODELS as readonly string[]).includes(model)) {
    throw new SetupError(`--remote-model must be one of ${REMOTE_MODELS.join(', ')}`);
  }

  switch (kind) {
    case 'anthropic':
      if (!hasKey)
        console.log(
          yellow(
            '  No Anthropic credentials found. Set ANTHROPIC_API_KEY or run `ant auth login` before escalating.',
          ),
        );
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
            '  Bedrock bills differently from the Anthropic API; set models.remote.price for accurate savings.',
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
  }
}

/** First-run prompt before the TUI opens. Declining continues with built-in defaults. */
export async function offerSetup(cwd: string): Promise<number> {
  const p = new Prompter();
  const yes = await p.confirm(`${bold('No Harness configuration found.')} Set up your models now?`);
  p.close();
  if (!yes) {
    console.log(
      dim(
        'Continuing without a local model; turns will run remotely. Run `harness init` any time.\n',
      ),
    );
    return 0;
  }
  return init({ cwd, yes: false, noLocal: false });
}
