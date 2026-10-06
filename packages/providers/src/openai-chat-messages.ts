/**
 * The neutral transcript as Chat Completions messages. Tool results become
 * `tool` messages; a user turn's text and images (its own, and any a tool
 * returned, which `tool` messages can't carry) follow as one user message.
 */
import type { ImagePart, ModelRef } from '@switchback/protocol';
import type OpenAI from 'openai';
import type { ChatRequest } from './types.ts';

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      reasoning_details?: unknown[];
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Structured reasoning from a gateway, kept on `ReasoningPart.opaque`. */
export interface ReasoningOpaque {
  reasoningDetails?: unknown[];
}

/**
 * Translate the neutral transcript. Only reasoning that `model` produced is
 * ever sent back: its `reasoning_details` always (gateways need them on tool-call
 * turns), and its text as `reasoning_content` only when `replayText` is set
 * (DeepSeek).
 */
export function toWireMessages(
  system: string,
  messages: ChatRequest['messages'],
  model?: ModelRef,
  replayText = false,
): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      const text: string[] = [];
      const images: ImagePart[] = [];
      for (const p of m.parts) {
        if (p.type === 'tool_result') {
          const content = p.isError ? `Error: ${p.content}` : p.content;
          out.push({ role: 'tool', tool_call_id: p.callId, content });
          images.push(...(p.images ?? []));
        } else if (p.type === 'text') text.push(p.text);
        else if (p.type === 'image') images.push(p);
      }
      // Text alone stays a plain string, as every server accepts.
      if (images.length)
        out.push({
          role: 'user',
          content: [
            ...(text.length ? [{ type: 'text' as const, text: text.join('\n') }] : []),
            ...images.map((i) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${i.mediaType};base64,${i.data}` },
            })),
          ],
        });
      else if (text.length) out.push({ role: 'user', content: text.join('\n') });
    } else {
      const text = m.parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const own = m.parts.flatMap((p) =>
        p.type === 'reasoning' &&
        model &&
        p.origin.provider === model.provider &&
        p.origin.model === model.model
          ? [p]
          : [],
      );
      const reasoning = replayText ? own.map((p) => p.text).join('') : '';
      const details = own.flatMap(
        (p) => (p.opaque as ReasoningOpaque | undefined)?.reasoningDetails ?? [],
      );
      const calls = m.parts.filter((p) => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(details.length ? { reasoning_details: details } : {}),
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}
