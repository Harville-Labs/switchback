/** `switchback init`: hosted providers, their models, and credentials. */
import {
  catalogFor,
  OPENROUTER_BASE_URL,
  REMOTE_KINDS,
  REMOTE_PROVIDERS,
  type RemoteAnswer,
  type RemoteKind,
} from '@switchback/engine';
import {
  CATALOG,
  CREDENTIAL_ENV,
  type HostedProviderKind,
  hasAnthropicCredentials,
  type ListedModel,
  listModels,
} from '@switchback/providers';
import { bold, dim, type Prompter, yellow } from '../prompt.ts';
import { type InitFlags, SetupError } from './init-flags.ts';

export const remoteLabel = (kind: RemoteKind) => {
  const { name, detail } = REMOTE_PROVIDERS[kind];
  return detail ? `${name} (${detail})` : name;
};

export function credentialHint(kind: RemoteKind): string {
  switch (kind) {
    case 'claude-code':
      return Bun.which('claude')
        ? 'uses your `claude` sign-in'
        : 'install Claude Code and sign in with `claude`';
    case 'codex':
      return Bun.which('codex')
        ? 'uses your `codex` sign-in'
        : 'install Codex and sign in with `codex login`';
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
    case 'azure-openai':
      return process.env.AZURE_OPENAI_API_KEY
        ? 'credentials found'
        : 'AZURE_OPENAI_API_KEY or Entra ID, and a deployment';
    case 'openrouter':
      return process.env.OPENROUTER_API_KEY ? 'credentials found' : 'needs OPENROUTER_API_KEY';
    case 'openai-compatible':
      return 'base URL and API key';
  }
}

/**
 * Hosted models: a provider at a time, each with its own setup. `suggest`
 * is the default answer to whether to set any up (yes when there are no
 * local models).
 */
export async function chooseRemotes(
  flags: InitFlags,
  p: Prompter | undefined,
  suggest = true,
): Promise<RemoteAnswer[]> {
  if (!p) {
    if (!flags.remotes.length)
      throw new SetupError(`pass --remote (${[...REMOTE_KINDS, 'none'].join(', ')})`);
    const kinds = flags.remotes.filter((k): k is RemoteKind => k !== 'none');
    const out: RemoteAnswer[] = [];
    for (const [i, kind] of kinds.entries())
      out.push(await chooseRemote(kind, flags.remoteModels[i], flags, undefined));
    return out;
  }
  if (!(await p.confirm(`\n${bold('Set up any remote providers?')}`, suggest))) return [];
  const chosen: RemoteAnswer[] = [];
  for (;;) {
    const kind: RemoteKind = await p.select(
      'Which provider?',
      REMOTE_KINDS.map((k) => ({ label: remoteLabel(k), value: k, hint: credentialHint(k) })),
    );
    chosen.push(await chooseRemote(kind, undefined, flags, p));
    if (!(await p.confirm('\nAny additional remote providers?', false))) break;
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

  if (kind === 'openai-compatible' || kind === 'openrouter') {
    const baseUrl =
      kind === 'openrouter'
        ? OPENROUTER_BASE_URL
        : (flags.remoteUrl ??
          (p ? await p.text('API base URL (e.g. https://api.together.xyz/v1)') : undefined));
    if (!baseUrl) throw new SetupError('--remote-url is required for openai-compatible');
    const apiKeyEnv =
      flags.remoteKeyEnv ??
      (kind === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : p
          ? await p.text('Environment variable holding the API key')
          : undefined);
    // Most endpoints list their models; some also give context lengths and prices.
    const listed = await listModels(baseUrl, {
      ...(apiKeyEnv && env[apiKeyEnv] ? { apiKey: env[apiKeyEnv] } : {}),
    }).catch((err: Error) => {
      if (p) console.log(dim(`  Couldn't list models (${err.message}); enter one by hand.`));
      return [];
    });
    const model =
      modelFlag ??
      (p && listed.length
        ? await p.search(
            `Which model? ${dim(`${listed.length} available; type to filter`)}`,
            listed.map((m) => ({ label: m.id, value: m.id, hint: listedHint(m) })),
            { freeText: true },
          )
        : p
          ? await p.text('Model ID')
          : undefined);
    if (!model) throw new SetupError(`--remote-model is required for ${kind}`);
    const found = listed.find((m) => m.id === model);
    if (listed.length && !found)
      console.log(
        yellow(`  ${model} isn't in ${new URL(baseUrl).host}'s model list; check the ID.`),
      );
    if (found?.tools === false)
      console.log(yellow(`  ${model} doesn't take tools there, so it can't edit or run anything.`));
    const contextWindow =
      found?.contextWindow ??
      flags.remoteContextWindow ??
      (p ? await p.number('Context window (tokens)', 128_000) : undefined) ??
      128_000;
    if (found?.price && p)
      console.log(
        dim(`  $${found.price.input} / $${found.price.output} per M tokens, from the model list`),
      );
    return {
      kind,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      contextWindow,
      ...(found?.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}),
      ...(found?.price ? { price: found.price } : {}),
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
  if (hint.startsWith('needs') || hint.startsWith('install'))
    console.log(yellow(`  ${remoteLabel(kind)} ${hint} before Switchback can use it.`));

  switch (kind) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
    case 'gemini':
    case 'claude-code':
    case 'codex':
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
    case 'azure-openai': {
      const resource =
        flags.resource ?? (p ? await p.text('Azure OpenAI resource name') : undefined);
      if (!resource) throw new SetupError('Azure OpenAI needs --resource');
      const deployment = flags.deployment ?? (p ? await p.text('Deployment name', model) : model);
      const auth =
        flags.azureAuth ??
        (p
          ? await p.select('Sign in with', [
              {
                label: 'API key',
                value: 'key' as const,
                hint: env.AZURE_OPENAI_API_KEY
                  ? 'AZURE_OPENAI_API_KEY found'
                  : 'AZURE_OPENAI_API_KEY',
              },
              {
                label: 'Microsoft Entra ID',
                value: 'entra' as const,
                hint: 'az login, managed identity, or AZURE_CLIENT_* variables',
              },
            ])
          : 'key');
      if (p)
        console.log(
          dim(
            '  Prices are OpenAI list prices; Azure billing can differ, so set models.<alias>.price if it does.',
          ),
        );
      return {
        kind,
        model,
        deployment: deployment || model,
        resource,
        ...(auth === 'entra' ? { auth } : {}),
      };
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

/** What the endpoint said about a model, for the picker. */
function listedHint(m: ListedModel): string {
  return [
    m.contextWindow ? `ctx ${m.contextWindow.toLocaleString('en-US')}` : undefined,
    m.price ? `$${m.price.input} / $${m.price.output} per M` : undefined,
    m.tools === false ? 'no tool calling' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
