/** The TUI's session commands: /new, /resume, /sessions, /rename. */
import { addInfo, fromTranscript, initialView } from '@switchback/client';
import { SESSION_TITLE_MAX } from '@switchback/protocol';
import { ago } from './SessionPicker.tsx';
import { type SlashContext, say } from './slash-context.ts';

export async function newSession(ctx: SlashContext, agent?: string): Promise<void> {
  try {
    const s = await ctx.client.request('session.create', agent ? { agent } : {});
    ctx.setSession(s);
    ctx.setView((v) =>
      addInfo({ ...initialView(s.id), items: v.items }, `new session · agent ${s.agent}`),
    );
  } catch (err) {
    say(ctx, (err as Error).message);
  }
}

/** Switch to a saved session: by number from /sessions, by ID, or (with neither) from a picker. */
export async function resume(ctx: SlashContext, which: string | undefined): Promise<void> {
  if (!which) return ctx.openPicker();
  const target = /^\d+$/.test(which) ? ctx.listed[Number(which) - 1]?.id : which;
  if (!target) return say(ctx, `no session ${which} in the last /sessions list`);
  if (target === ctx.session.id) return say(ctx, 'already in that session');
  // Open in another tab: go there rather than showing it twice.
  if (ctx.tabs.tabs.some((t) => t.session.id === target)) return ctx.showSession(target);
  try {
    const { session: s, messages } = await ctx.client.request('session.get', {
      sessionId: target,
    });
    const history = fromTranscript(s, messages);
    ctx.setSession(s);
    ctx.setView((v) => ({
      ...history,
      items: [
        ...v.items,
        {
          kind: 'info',
          id: `resume-${s.id}-${v.items.length}`,
          text: `── resumed "${s.title || s.id}" ──`,
        },
        ...history.items,
      ],
    }));
  } catch (err) {
    say(ctx, (err as Error).message);
  }
}

export async function listSessions(ctx: SlashContext): Promise<void> {
  const all = await ctx.client.request('session.list', {});
  ctx.setListed(all);
  if (!all.length) return say(ctx, 'no saved sessions in this workspace yet');
  const rows = all
    .slice(0, 20)
    .map(
      (x, i) =>
        `${String(i + 1).padStart(2)}. ${x.id === ctx.session.id ? '* ' : ''}${x.title || '(untitled)'}  ${x.agent} · ${ago(x.updatedAt)} · $${x.costUsd.toFixed(3)}`,
    );
  say(ctx, [...rows, '/resume to pick one, or /resume <number>'].join('\n'));
}

/** `/rename <title>`; with no title, show the current one. */
export async function rename(ctx: SlashContext, title: string): Promise<void> {
  if (!title.trim())
    return say(
      ctx,
      `${ctx.session.title ? `this session is "${ctx.session.title}"` : 'this session has no title yet'}; /rename <title> (up to ${SESSION_TITLE_MAX} characters) changes it`,
    );
  try {
    ctx.setSession(
      await ctx.client.request('session.rename', { sessionId: ctx.session.id, title }),
    );
  } catch (err) {
    say(ctx, `rename: ${(err as Error).message}`);
  }
}
