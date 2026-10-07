/** `switchback init`: local model servers, detected or entered by hand. */
import { type DetectedServer, detectLocalServers, type LocalAnswer } from '@switchback/engine';
import { bold, dim, type Prompter, yellow } from '../prompt.ts';
import { type InitFlags, SetupError } from './init-flags.ts';

type Pick = { server: DetectedServer; model: DetectedServer['models'][number] } | 'manual' | 'done';

const ADD_LOCAL =
  'Add another local model? (A bigger one to escalate to, a backup, or a reviewer: you choose roles next.)';

export async function chooseLocals(
  flags: InitFlags,
  p: Prompter | undefined,
): Promise<LocalAnswer[]> {
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
  if (!probe?.models.length)
    console.log(yellow('  Could not list models at that URL; continuing anyway.'));
  const model = probe?.models.length
    ? await p.search(
        'Model name',
        probe.models.map((m) => ({ label: m.id, value: m.id })),
        { freeText: true },
      )
    : await p.text('Model name');
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

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
