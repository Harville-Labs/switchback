/** Setup: local model servers, detected or entered by hand. */
import { type DetectedServer, detectLocalServers } from '@switchback/providers';
import type { LocalAnswer } from '../setup.ts';
import { SetupError, type SetupFlags } from './flags.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';

type Detect = typeof detectLocalServers;

/**
 * Local models: endpoints one at a time, each with the models to use from it.
 * Servers already running here are found first and offered as the answers.
 */
export async function chooseLocals(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  detect: Detect = detectLocalServers,
): Promise<LocalAnswer[]> {
  const p = asking(ui);
  if (flags.noLocal) return [];
  say(ui, 'Looking for model servers on this machine...', 'detail');
  const servers = await detect({ extra: flags.localUrls });

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

  const found = servers.filter((s) => s.models.length);
  say(
    ui,
    found.length
      ? `Found ${found.map((s) => `${s.label} (${s.baseUrl})`).join(', ')}.`
      : 'Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible server.',
    'detail',
  );
  const hasAny = await p.confirm('Do you have any local model endpoints?', found.length > 0);
  if (!hasAny) return [];

  const chosen: LocalAnswer[] = [];
  const used = new Set<string>();
  for (;;) {
    const next = found.find((s) => !used.has(s.baseUrl));
    const baseUrl = normalizeUrl(
      await p.text(
        'Endpoint URL',
        next?.baseUrl ?? flags.localUrls[0] ?? 'http://localhost:11434/v1',
      ),
    );
    used.add(baseUrl);
    const server =
      servers.find((s) => s.baseUrl === baseUrl) ??
      (await detect({ extra: [baseUrl] })).find((s) => s.baseUrl === baseUrl);
    if (server?.models.length) chosen.push(...(await pickModels(server, p)));
    else chosen.push(await manualLocal(baseUrl, p));
    if (!(await p.confirm('Any more local endpoints?', false))) break;
  }
  return chosen;
}

/** The models to use from a server that lists them: a checklist, tool-capable ones first. */
async function pickModels(server: DetectedServer, p: SetupPrompter): Promise<LocalAnswer[]> {
  if (server.note) say(p, server.note, 'detail');
  const models = [...server.models].sort(
    (a, b) => Number(b.tools === true) - Number(a.tools === true),
  );
  const picked = await p.multiSelect(
    `Which models from ${server.label}?`,
    models.map((model) => ({
      label: model.id,
      value: model,
      hint: [
        model.contextWindow ? `ctx ${model.contextWindow.toLocaleString('en-US')}` : undefined,
        model.tools === true ? 'tools ✓' : model.tools === false ? 'no tool calling' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  );
  if (!picked.length) say(p, `No models picked from ${server.label}.`, 'warning');
  const out: LocalAnswer[] = [];
  for (const model of picked) {
    if (model.tools === false)
      say(
        p,
        `${model.id} doesn't report tool-calling support. Switchback will escalate often with it.`,
        'warning',
      );
    // Asked only when the server can't say; the engine asks it again at runtime otherwise.
    const contextWindow =
      model.contextWindow ??
      (await p.number(
        `Context window (tokens) for ${model.id}${model.maxContext ? `; the model's maximum is ${model.maxContext.toLocaleString('en-US')}` : ', as the server loads it'}`,
        32_768,
      )) ??
      32_768;
    out.push({
      providerId: server.kind === 'openai-compatible' ? 'local-server' : server.kind,
      baseUrl: server.baseUrl,
      model: model.id,
      contextWindow,
    });
  }
  return out;
}

/** An endpoint that didn't list its models (down, or it needs a key): one model, by hand. */
async function manualLocal(baseUrl: string, p: SetupPrompter): Promise<LocalAnswer> {
  say(p, `Couldn't list models at ${baseUrl}; enter one by hand.`, 'warning');
  const model = await p.text('Model name');
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

export function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}
