/**
 * How `switchback run` reports: `text` (the answer on stdout, activity on
 * stderr), `json` (one result object at the end), or `events` (every protocol
 * event as a line of JSON, as it happens).
 */
import { privateLabel, redactedLabel, reviewLines } from '@switchback/client';
import { type EngineEvent, isSessionEvent } from '@switchback/protocol';

export type RunOutput = 'text' | 'json' | 'events';

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

/** A printer for one session's events; returns nothing for formats that print only at the end. */
export function eventPrinter(output: RunOutput, sessionId: string): (e: EngineEvent) => void {
  if (output === 'events') return (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
  if (output === 'json') return () => {};
  let pinned = false;
  const err = (s: string) => process.stderr.write(dim(`${s}\n`));
  return (e) => {
    if (e.type === 'config.updated') {
      err(`[${e.org ? `${e.org.name} policy updated` : 'config updated'}]`);
      return;
    }
    if (!isSessionEvent(e) || e.sessionId !== sessionId) return;
    switch (e.type) {
      case 'text.delta':
        process.stdout.write(e.text);
        return;
      case 'route.decided':
        return err(`[${e.tier} · ${e.model.model} · ${e.reason}]`);
      case 'tool.started':
        return err(`\n▸ ${e.name}`);
      case 'tool.completed':
        if (e.isError) err(`  ✗ ${e.output.split('\n')[0]}`);
        if (e.private && !pinned) {
          pinned = true;
          err(privateLabel(e.private));
        }
        return;
      case 'review.completed':
        return err(reviewLines({ ...e, kind: 'review', id: e.turnId }).join('\n'));
      case 'secrets.redacted':
        return err(redactedLabel(e.kinds, e.model));
      case 'subagent.started':
        return err(`↳ ${e.agent}: ${e.task}`);
      case 'error':
        process.stderr.write(`error: ${e.message}\n`);
        return;
    }
  };
}
