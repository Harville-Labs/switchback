/**
 * The models a Claude Code or Codex sign-in can use right now, as the CLI
 * itself reports them, so a model released after this version of Switchback
 * shows up without an update. Each returns undefined when it can't tell
 * (no CLI, not signed in, timed out); callers then fall back to the catalog.
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface ListedSubscriptionModel {
  id: string;
  label?: string;
  contextWindow?: number;
}

/** One `model/list` page from `codex app-server`. */
const CodexModelPage = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      displayName: z.string().optional(),
      hidden: z.boolean().optional(),
    }),
  ),
  nextCursor: z.string().nullish(),
});

/** A JSON-RPC line connection to `codex app-server`; tests pass their own. */
export interface CodexConnection {
  request(method: string, params: object): Promise<unknown>;
  notify(method: string): void;
  close(): void;
}

/** `codex app-server` over stdio: one JSON-RPC message per line. */
function spawnCodex(executable: string): CodexConnection {
  const child = Bun.spawn([executable, 'app-server'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  void (async () => {
    let buf = '';
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = msg.id === undefined ? undefined : pending.get(msg.id);
        if (!waiter || msg.id === undefined) continue;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message ?? 'codex app-server error'));
        else waiter.resolve(msg.result);
      }
    }
    for (const w of pending.values()) w.reject(new Error('codex app-server exited'));
  })();
  const send = (msg: object) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.stdin.flush();
  };
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      }),
    notify: (method) => send({ method }),
    close: () => child.kill(),
  };
}

/** Asks Codex's app server which models the signed-in account offers; hidden ones are internal. */
export async function codexModels(
  options: {
    executable?: string;
    connect?: (executable: string) => CodexConnection;
    timeoutMs?: number;
  } = {},
): Promise<ListedSubscriptionModel[] | undefined> {
  const executable = options.executable ?? Bun.which('codex');
  if (!executable) return undefined;
  let conn: CodexConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const list = async () => {
    conn = (options.connect ?? spawnCodex)(executable);
    await conn.request('initialize', {
      clientInfo: { name: 'switchback', title: 'Switchback', version: '1' },
    });
    conn.notify('initialized');
    const out: ListedSubscriptionModel[] = [];
    let cursor: string | undefined;
    do {
      const page = CodexModelPage.parse(await conn.request('model/list', cursor ? { cursor } : {}));
      for (const m of page.data)
        if (!m.hidden) out.push({ id: m.id, ...(m.displayName ? { label: m.displayName } : {}) });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out.length ? out : undefined;
  };
  try {
    return await Promise.race([
      list(),
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), options.timeoutMs ?? 30_000);
      }),
    ]);
  } catch {
    // Not signed in, or a Codex too old to list models; the catalog stands in.
    return undefined;
  } finally {
    clearTimeout(timer);
    conn?.close();
  }
}

type QueryFn = (params: { prompt: AsyncIterable<never>; options?: object }) => Query;

/**
 * Asks Claude Code, through the Agent SDK, which models the sign-in offers.
 * Nothing is sent to a model: the CLI starts, answers, and is closed.
 */
export async function claudeModels(
  options: { executable?: string; query?: QueryFn; timeoutMs?: number } = {},
): Promise<ListedSubscriptionModel[] | undefined> {
  const query =
    options.query ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn);
  let release = () => {};
  // Control requests need streaming input; this one never sends a prompt.
  const idle = (async function* (): AsyncGenerator<never> {
    await new Promise<void>((r) => {
      release = r;
    });
  })();
  const q = query({
    prompt: idle,
    options: {
      settingSources: [],
      ...(options.executable ? { pathToClaudeCodeExecutable: options.executable } : {}),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listed = await Promise.race([
      q.supportedModels(),
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), options.timeoutMs ?? 30_000);
      }),
    ]);
    if (!listed) return undefined;
    // Rows are aliases (`sonnet`, `opus[1m]`); several resolve to one model.
    const byId = new Map<string, ListedSubscriptionModel>();
    for (const m of listed) {
      const id = m.resolvedModel ?? m.value;
      if (id.startsWith('claude-') && !byId.has(id)) byId.set(id, { id, label: m.displayName });
    }
    return byId.size ? [...byId.values()] : undefined;
  } catch {
    // Not installed or not signed in; the catalog stands in until it is.
    return undefined;
  } finally {
    clearTimeout(timer);
    release();
    q.close();
  }
}
