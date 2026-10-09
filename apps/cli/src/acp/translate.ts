/**
 * Pure translation between Switchback's protocol and the Agent Client
 * Protocol (agentclientprotocol.com): engine events and transcripts become
 * ACP session updates, and ACP prompt blocks become a prompt and attachments.
 * Titles come from @switchback/client, so editors on ACP describe tool calls
 * the way the TUI and VS Code do.
 */

import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { toolTitle } from '@switchback/client';
import type {
  Attachment,
  EngineEvent,
  Message,
  PermissionMode,
  StopReason,
} from '@switchback/protocol';

export type AcpUpdate = acp.SessionNotification['update'];

/** Switchback's permission modes, as ACP session modes. */
export const MODES: acp.SessionMode[] = [
  { id: 'default', name: 'Default', description: 'Ask before edits and commands' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edit files without asking' },
  { id: 'plan', name: 'Plan', description: 'Read and plan; change nothing until you approve' },
  { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Never ask' },
];

export function modeState(mode: PermissionMode | undefined): acp.SessionModeState {
  return { currentModeId: mode ?? 'default', availableModes: MODES };
}

export function isMode(id: string): id is PermissionMode {
  return MODES.some((m) => m.id === id);
}

const KINDS: Record<string, acp.ToolKind> = {
  read: 'read',
  glob: 'search',
  grep: 'search',
  edit: 'edit',
  write: 'edit',
  bash: 'execute',
  bash_output: 'execute',
  kill_shell: 'execute',
  webfetch: 'fetch',
  websearch: 'fetch',
  docs: 'read',
  skill: 'read',
  todo: 'think',
  task: 'think',
  exit_plan_mode: 'switch_mode',
};

export function toolKind(name: string): acp.ToolKind {
  return KINDS[name] ?? 'other';
}

/** `Read src/app.ts`, `Bash bun test`: the TUI's title for the call. */
export function toolCallTitle(name: string, input: unknown): string {
  const { verb, target } = toolTitle(name, input);
  return target ? `${verb} ${target}` : verb;
}

function locations(input: unknown, cwd: string): acp.ToolCallLocation[] | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.path === 'string' ? i.path : undefined;
  if (!path) return undefined;
  return [{ path: isAbsolute(path) ? path : `${cwd}${sep}${path}` }];
}

export function toolCallStarted(
  e: Extract<EngineEvent, { type: 'tool.started' }>,
  cwd: string,
): AcpUpdate {
  const where = locations(e.input, cwd);
  return {
    sessionUpdate: 'tool_call',
    toolCallId: e.callId,
    title: toolCallTitle(e.name, e.input),
    kind: toolKind(e.name),
    status: 'in_progress',
    rawInput: e.input,
    ...(where ? { locations: where } : {}),
  };
}

const text = (t: string): acp.ToolCallContent => ({
  type: 'content',
  content: { type: 'text', text: t },
});

export function toolCallCompleted(e: Extract<EngineEvent, { type: 'tool.completed' }>): AcpUpdate {
  // An edit's unified diff reads better than the tool's one-line result.
  const shown = e.diff ? `\`\`\`diff\n${e.diff}\n\`\`\`` : e.output;
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: e.callId,
    status: e.isError || e.denied ? 'failed' : 'completed',
    ...(shown ? { content: [text(shown)] } : {}),
  };
}

/** The todo tool's checklist as an ACP plan; undefined for any other call. */
export function planOf(name: string, input: unknown): AcpUpdate | undefined {
  if (name !== 'todo') return undefined;
  const items = (input as { items?: { text: string; status: string }[] })?.items ?? [];
  return {
    sessionUpdate: 'plan',
    entries: items.map((i) => ({
      content: i.text,
      priority: 'medium',
      status:
        i.status === 'done' ? 'completed' : i.status === 'in_progress' ? 'in_progress' : 'pending',
    })),
  };
}

/**
 * ACP's reason for the end of a turn. Undefined for an error, which the
 * prompt request reports as an error instead.
 */
export function stopReasonOf(reason: StopReason): acp.StopReason | undefined {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
      return 'end_turn';
    case 'max_tokens':
    case 'refusal':
    case 'cancelled':
      return reason;
    case 'error':
      return undefined;
  }
}

/**
 * A prompt's blocks as Switchback's prompt text and attachments. Files in
 * the workspace are attached by path, so privacy rules and deny rules apply
 * to them as to an `@mention`; resources the editor embedded come as text.
 */
export function promptOf(
  blocks: acp.ContentBlock[],
  cwd: string,
): { text: string; attachments: Attachment[] } {
  const parts: string[] = [];
  const attachments: Attachment[] = [];
  let images = 0;
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'image')
      attachments.push({ kind: 'image', name: `image ${++images}`, data: b.data });
    else if (b.type === 'resource_link') {
      const path = workspacePath(b.uri, cwd);
      if (path) attachments.push({ kind: 'file', path });
      else parts.push(b.uri);
    } else if (b.type === 'resource' && 'text' in b.resource)
      attachments.push({ kind: 'text', label: b.resource.uri, text: b.resource.text });
  }
  const prompt = parts.join('\n').trim();
  const names = attachments.map((a) =>
    a.kind === 'file' ? a.path : a.kind === 'text' ? a.label : a.name,
  );
  return { text: prompt || `See ${names.join(', ') || 'the attachments'}.`, attachments };
}

/** A `file://` URI or path as a workspace-relative path; undefined outside the workspace. */
export function workspacePath(uri: string, cwd: string): string | undefined {
  let path: string;
  try {
    path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    // Not a file URI after all (another scheme); the caller passes it along as text.
    return undefined;
  }
  if (!isAbsolute(path)) return undefined;
  const rel = relative(cwd, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * A saved transcript as the updates a client replays for `session/load`:
 * what the user said, what the model said and thought, and each tool call
 * with its result. Context the engine added for the model isn't shown.
 */
export function replay(messages: Message[], cwd: string): AcpUpdate[] {
  const updates: AcpUpdate[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' && !p.reminder && !p.attachment && !p.backgroundTask && !p.review)
        updates.push({
          sessionUpdate: m.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: p.text },
        });
      else if (p.type === 'reasoning')
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: p.text },
        });
      else if (p.type === 'tool_call') {
        updates.push({
          ...(toolCallStarted(
            {
              type: 'tool.started',
              sessionId: '',
              turnId: '',
              callId: p.id,
              name: p.name,
              input: p.input,
            },
            cwd,
          ) as Extract<AcpUpdate, { sessionUpdate: 'tool_call' }>),
          status: 'pending',
        });
        const plan = planOf(p.name, p.input);
        if (plan) updates.push(plan);
      } else if (p.type === 'tool_result')
        updates.push({
          sessionUpdate: 'tool_call_update',
          toolCallId: p.callId,
          status: p.isError ? 'failed' : 'completed',
          ...(p.content ? { content: [text(p.content)] } : {}),
        });
    }
  }
  return updates;
}
