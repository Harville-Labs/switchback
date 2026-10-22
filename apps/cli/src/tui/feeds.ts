/**
 * What the app keeps from the engine besides the transcript: every
 * session's events folded into the tabs, plus usage, custom commands, MCP
 * resources, and the session in front's roles.
 */
import {
  AttentionTracker,
  customCommands,
  reduceTabs,
  SessionScope,
  type SlashCommand,
  type SwitchbackClient,
  type TabsState,
  trackSessions,
} from '@switchback/client';
import type { InitializeResult, SessionRoles, UsageReport } from '@switchback/protocol';
import { useStdout } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { terminalNotification } from './notify.ts';

export function useEngineFeeds(
  client: SwitchbackClient,
  init: InitializeResult,
  sessionId: string,
  tabs: TabsState,
  setTabs: (update: (t: TabsState) => TabsState) => void,
) {
  const { stdout } = useStdout();
  const [usage, setUsage] = useState<UsageReport | undefined>();
  const [roles, setRoles] = useState<SessionRoles | undefined>();
  /** Custom commands from `.switchback/commands/` and yours, for the menu and /help. */
  const [custom, setCustom] = useState<SlashCommand[]>([]);
  /** Configured models; a config reload or `/models refresh` can change them. */
  const [models, setModels] = useState(init.models);
  /** MCP resources, as `server:uri`, for @ completion. */
  const [resources, setResources] = useState<string[]>([]);
  useEffect(() => {
    client.request('mcp.list', {}).then(
      ({ servers }) =>
        setResources(servers.flatMap((s) => (s.resources ?? []).map((r) => `${s.name}:${r.uri}`))),
      () => {},
    );
  }, [client]);

  useEffect(() => {
    client.request('session.roles', { sessionId }).then(setRoles, () => {});
  }, [client, sessionId]);

  const refreshUsage = useCallback(() => {
    client.request('usage.get', {}).then(setUsage, () => {});
    // Command files can change between turns; the engine rescans them on each list.
    client.request('commands.list', {}).then(
      (c) => setCustom(customCommands(c)),
      () => {},
    );
  }, [client]);

  /** Titles, costs, and running flags for the tabs and the dashboard, from the engine. */
  const refreshSessions = useCallback(() => {
    client.request('session.list', {}).then(
      (all) => setTabs((t) => trackSessions(t, all)),
      () => {},
    );
  }, [client, setTabs]);
  useEffect(refreshSessions, [refreshSessions]);

  // Sessions opened in a tab here. A shared daemon sends this window other
  // windows' events too, and their prompts mustn't notify here.
  const [scope] = useState(() => new SessionScope());
  useEffect(() => {
    for (const t of tabs.tabs) scope.add(t.session.id);
  }, [tabs.tabs, scope]);
  // One tracker for the app's life: it remembers when turns started.
  const [attention] = useState(() => new AttentionTracker(scope, init.notifications));
  useEffect(() => {
    refreshUsage();
    return client.on((event) => {
      // Every session's events: each tab's view stays live, in front or not.
      setTabs((t) => reduceTabs(t, event));
      if (event.type === 'config.updated' && event.models) setModels(event.models);
      const a = attention.observe(event);
      if (a) stdout.write(terminalNotification(a.message, init.notifications?.mode ?? 'system'));
      if (event.type === 'turn.completed' && event.sessionId === sessionId) refreshUsage();
      // A turn starting or ending names a title, or a session from another window.
      if (
        (event.type === 'turn.started' || event.type === 'turn.completed') &&
        !event.parentSessionId
      )
        refreshSessions();
    });
  }, [
    client,
    sessionId,
    setTabs,
    refreshUsage,
    refreshSessions,
    attention,
    init.notifications,
    stdout,
  ]);

  return { usage, setUsage, roles, custom, resources, models, refreshSessions };
}
