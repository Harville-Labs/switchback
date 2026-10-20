/** Setup: hosted providers, their models, and credentials. */
import {
  aliasModels,
  CATALOG,
  type HostedProviderKind,
  type ListedModel,
  listModels,
  OPENCODE_BASE_URL,
  openCodeApi,
} from '@switchback/providers';
import {
  catalogFor,
  OPENROUTER_BASE_URL,
  REMOTE_KINDS,
  REMOTE_PROVIDERS,
  type RemoteAnswer,
  type RemoteKind,
} from '../setup.ts';
import { SetupError, type SetupFlags } from './flags.ts';
import { askApiKey, credentialHint, type Env, hasKey, keyEnv } from './keys.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';

type List = typeof listModels;

export const remoteLabel = (kind: RemoteKind) => {
  const { name, detail } = REMOTE_PROVIDERS[kind];
  return detail ? `${name} (${detail})` : name;
};

/**
 * Hosted models: a provider at a time, each with its own setup. `suggest`
 * is the default answer to whether to set any up (yes when there are no
 * local models).
 */
export async function chooseRemotes(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  suggest = true,
  /** Model listing; tests pass their own. */
  list: List = listModels,
  env: Env = process.env,
): Promise<RemoteAnswer[]> {
  const p = asking(ui);
  if (!p) {
    if (!flags.remotes.length)
      throw new SetupError(`pass --remote (${[...REMOTE_KINDS, 'none'].join(', ')})`);
    const kinds = flags.remotes.filter((k): k is RemoteKind => k !== 'none');
    const out: RemoteAnswer[] = [];
    for (const [i, kind] of kinds.entries())
      out.push(...(await chooseRemote(kind, flags.remoteModels[i], flags, ui, list, env)));
    return out;
  }
  if (!(await p.confirm('Set up any remote providers?', suggest))) return [];
  const chosen: RemoteAnswer[] = [];
  for (;;) {
    const kind: RemoteKind = await p.select(
      'Which provider?',
      REMOTE_KINDS.map((k) => ({ label: remoteLabel(k), value: k, hint: credentialHint(k, env) })),
    );
    chosen.push(...(await chooseRemote(kind, undefined, flags, ui, list, env)));
    if (!(await p.confirm('Any additional remote providers?', false))) break;
  }
  return chosen;
}

/** One provider's answers: one model, or every model a subscription covers. */
async function chooseRemote(
  kind: RemoteKind,
  modelFlag: string | undefined,
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  list: List,
  env: Env,
): Promise<RemoteAnswer[]> {
  const p = asking(ui);
  const label = REMOTE_PROVIDERS[kind].name;
  // Asked only when the provider wouldn't find a key on its own.
  const apiKey = async (envName = keyEnv(kind)) =>
    hasKey(kind, env) ? undefined : askApiKey(label, envName, flags, ui);
  const withKey = <T extends object>(answer: T, key: string | undefined) =>
    key ? { ...answer, apiKey: key } : answer;

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
          ? await p.text('Environment variable holding the API key (leave empty to paste one)')
          : undefined);
    const key = apiKeyEnv
      ? env[apiKeyEnv]
        ? undefined
        : await askApiKey(label, apiKeyEnv, flags, ui)
      : await optionalKey(label, flags, ui);
    // Most endpoints list their models; some also give context lengths and prices.
    const listKey = key ?? (apiKeyEnv ? env[apiKeyEnv] : undefined);
    const listed = await list(baseUrl, listKey ? { apiKey: listKey } : {}).catch((err: Error) => {
      say(ui, `Couldn't list models (${err.message}); enter one by hand.`, 'detail');
      return [];
    });
    const model =
      modelFlag ??
      (p && listed.length
        ? await p.search(
            `Which model? (${listed.length} available; type to filter)`,
            listed.map((m) => ({ label: m.id, value: m.id, hint: listedHint(m) })),
            { freeText: true },
          )
        : p
          ? await p.text('Model ID')
          : undefined);
    if (!model) throw new SetupError(`--remote-model is required for ${kind}`);
    const found = listed.find((m) => m.id === model);
    if (listed.length && !found)
      say(ui, `${model} isn't in ${new URL(baseUrl).host}'s model list; check the ID.`, 'warning');
    if (found?.tools === false)
      say(ui, `${model} doesn't take tools there, so it can't edit or run anything.`, 'warning');
    const contextWindow =
      found?.contextWindow ??
      flags.remoteContextWindow ??
      (p ? await p.number('Context window (tokens)', 128_000) : undefined) ??
      128_000;
    if (found?.price && p)
      say(
        ui,
        `$${found.price.input} / $${found.price.output} per M tokens, from the model list`,
        'detail',
      );
    return [
      withKey(
        {
          kind,
          baseUrl: baseUrl.replace(/\/+$/, ''),
          model,
          contextWindow,
          ...(found?.maxOutputTokens ? { maxOutputTokens: found.maxOutputTokens } : {}),
          ...(found?.price ? { price: found.price } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
        },
        key,
      ),
    ];
  }

  if (kind === 'opencode')
    return [withKey(await chooseOpenCode(modelFlag, flags, ui, list), await apiKey())];

  const catalog = CATALOG[catalogFor(kind) as HostedProviderKind];
  if ((kind === 'claude-code' || kind === 'codex') && !modelFlag) {
    const hint = credentialHint(kind, env);
    if (hint.startsWith('install'))
      say(ui, `${label}: ${hint} before Switchback can use it.`, 'warning');
    // A plan covers all its models, so there's nothing to choose: the medium
    // and large ones go in the ladder, and the rest are added when config loads.
    say(ui, `Every model on your plan is added, and new ones appear on the next launch.`, 'detail');
    const { medium, large } = aliasModels(catalogFor(kind) as HostedProviderKind);
    return [...new Set([medium.id, large.id])].map((model) => ({ kind, model }));
  }
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
  switch (kind) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
    case 'gemini':
      return [withKey({ kind, model }, await apiKey())];
    case 'claude-code':
    case 'codex': {
      const hint = credentialHint(kind, env);
      if (hint.startsWith('install'))
        say(ui, `${label}: ${hint} before Switchback can use it.`, 'warning');
      return [{ kind, model }];
    }
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
      say(
        ui,
        'Bedrock bills differently from the Anthropic API; set models.<alias>.price for accurate savings.',
        'detail',
      );
      return [{ kind, model, region, ...(profile ? { profile } : {}) }];
    }
    case 'vertex': {
      const fallbackProject = env.GOOGLE_CLOUD_PROJECT ?? env.CLOUDSDK_CORE_PROJECT;
      const projectId =
        flags.projectId ?? (p ? await p.text('GCP project ID', fallbackProject) : fallbackProject);
      if (!projectId) throw new SetupError('Vertex AI needs a project ID (--project-id)');
      const region = flags.region ?? (p ? await p.text('Region', 'global') : 'global');
      return [{ kind, model, projectId, region }];
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
      return [{ kind, model, region, workspaceId, ...(profile ? { profile } : {}) }];
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
                hint: hasKey(kind, env) ? 'key found' : 'paste one or set AZURE_OPENAI_API_KEY',
              },
              {
                label: 'Microsoft Entra ID',
                value: 'entra' as const,
                hint: 'az login, managed identity, or AZURE_CLIENT_* variables',
              },
            ])
          : 'key');
      say(
        ui,
        'Prices are OpenAI list prices; Azure billing can differ, so set models.<alias>.price if it does.',
        'detail',
      );
      return [
        withKey(
          {
            kind,
            model,
            deployment: deployment || model,
            resource,
            ...(auth === 'entra' ? { auth } : {}),
          },
          auth === 'entra' ? undefined : await apiKey(),
        ),
      ];
    }
    case 'foundry': {
      const resource =
        flags.resource ??
        (p
          ? await p.text('Foundry resource name', env.ANTHROPIC_FOUNDRY_RESOURCE)
          : env.ANTHROPIC_FOUNDRY_RESOURCE);
      if (!resource) throw new SetupError('Microsoft Foundry needs --resource');
      return [withKey({ kind, model, resource }, await apiKey())];
    }
  }
}

/**
 * A key for an OpenAI-compatible server that names no variable for one. Many
 * local gateways need none, so an empty answer is fine and isn't warned about.
 */
async function optionalKey(
  label: string,
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
): Promise<string | undefined> {
  const p = asking(ui);
  if (!p || flags.scope === 'project') return undefined;
  const key = await p.text(`API key for ${label} (leave empty if it needs none)`, undefined, {
    secret: true,
  });
  if (!key) return undefined;
  say(ui, 'The key goes in your user config, which only you can read.', 'detail');
  return key;
}

/** OpenCode: the plan, then a model from its live list (the list needs no key). */
async function chooseOpenCode(
  modelFlag: string | undefined,
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  list: List,
): Promise<RemoteAnswer> {
  const p = asking(ui);
  const plan =
    flags.opencodePlan ??
    (p
      ? await p.select('Which OpenCode plan?', [
          {
            label: 'OpenCode Go',
            value: 'go' as const,
            hint: 'monthly subscription to open coding models',
          },
          { label: 'OpenCode Zen', value: 'zen' as const, hint: 'pay as you go, many providers' },
        ])
      : 'go');
  const listed = await list(`${OPENCODE_BASE_URL[plan]}/v1`).catch((err: Error) => {
    say(ui, `Couldn't list OpenCode's models (${err.message}); enter one by hand.`, 'detail');
    return [];
  });
  // Gemini is served on Google's API there, which Switchback doesn't use through OpenCode.
  const usable = listed.filter((m) => openCodeApi(m.id) !== undefined);
  const model =
    modelFlag ??
    (p && usable.length
      ? await p.search(
          `Which model? (${usable.length} available; type to filter)`,
          usable.map((m) => ({ label: m.id, value: m.id })),
          { freeText: true },
        )
      : p
        ? await p.text('Model ID')
        : undefined);
  if (!model) throw new SetupError('--remote-model is required for opencode');
  if (!openCodeApi(model))
    throw new SetupError(
      `OpenCode serves ${model} on Google's API, which Switchback doesn't use through OpenCode; pick another model`,
    );
  const contextWindow =
    flags.remoteContextWindow ??
    (p ? await p.number('Context window (tokens)', 128_000) : undefined) ??
    128_000;
  return { kind: 'opencode', plan, model, contextWindow };
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
