/**
 * What MCP adds to a prompt: `/server:prompt args` becomes the server's
 * prompt, and each `@server:uri` attaches that resource, as `@path` does a
 * file. Only connected servers count, so other text with a colon is left
 * alone.
 */
import type { ImagePart, TextPart } from '@switchback/protocol';
import type { McpHub } from './hub.ts';

const MAX_RESOURCES = 10;
const MAX_RESOURCE_CHARS = 200_000;

export interface Expanded {
  text: string;
  parts: (TextPart | ImagePart)[];
}

export async function expandMcp(text: string, hub: McpHub | undefined): Promise<Expanded> {
  if (!hub) return { text, parts: [] };
  const parts: (TextPart | ImagePart)[] = [];
  let prompt = text;
  const command = /^\/([\w.-]+):(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (command?.[1] && command[2] && hub.has(command[1])) {
    // A prompt the server can't fill (a missing argument) fails the turn with its message.
    const filled = await hub.getPrompt(command[1], command[2], command[3] ?? '');
    prompt = filled.text;
    parts.push(...filled.images);
  }
  const mentions = [...prompt.matchAll(/(?:^|\s)@([\w.-]+):(\S+)/g)]
    .map((m) => ({ server: m[1] ?? '', uri: (m[2] ?? '').replace(/[.,;!?)\]]+$/, '') }))
    .filter((m) => hub.has(m.server) && m.uri)
    .slice(0, MAX_RESOURCES);
  const seen = new Set<string>();
  for (const { server, uri } of mentions) {
    const path = `${server}:${uri}`;
    if (seen.has(path)) continue;
    seen.add(path);
    const r = await hub.readResource(server, uri).catch((err: Error) => ({
      text: `[could not read: ${err.message}]`,
      images: [],
    }));
    if (r.text || !r.images.length)
      parts.push({
        type: 'text',
        text: `<resource server="${server}" uri="${uri.replace(/"/g, '&quot;')}">\n${r.text.slice(0, MAX_RESOURCE_CHARS)}\n</resource>`,
        attachment: { path },
      });
    parts.push(...r.images.map((i) => ({ ...i, attachment: { path } })));
  }
  return { text: prompt, parts };
}
