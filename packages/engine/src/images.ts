/**
 * Images in the transcript: read from the workspace or pasted by the user,
 * checked by their bytes (a declared type or file extension can lie), and
 * replaced with a note for models that can't see them.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  type ImageMediaType,
  type ImagePart,
  MAX_IMAGE_BYTES,
  type Message,
  type Part,
} from '@switchback/protocol';

/** The image format of these bytes, from their signature; undefined when it isn't one we send. */
export function sniffImage(bytes: Uint8Array): ImageMediaType | undefined {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/** Whether a path names an image file by extension (the bytes still decide). */
export function looksLikeImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(path);
}

const tooLarge = (bytes: number) =>
  `the image is ${(bytes / 1e6).toFixed(1)} MB; images can be at most ${MAX_IMAGE_BYTES / 1e6} MB, so resize or crop it first`;

/** An image file as an image part, or why it can't be one. */
export async function readImage(file: string, path: string): Promise<ImagePart | string> {
  const info = await stat(file);
  if (info.size > MAX_IMAGE_BYTES) return tooLarge(info.size);
  const bytes = new Uint8Array(await readFile(file));
  const mediaType = sniffImage(bytes);
  if (!mediaType) return 'not a PNG, JPEG, GIF, or WebP image';
  return {
    type: 'image',
    mediaType,
    data: Buffer.from(bytes).toString('base64'),
    attachment: { path },
  };
}

/** A pasted image (base64 from a client) as an image part, or why it can't be one. */
export function pastedImage(name: string, data: string): ImagePart | string {
  const bytes = new Uint8Array(Buffer.from(data, 'base64'));
  if (bytes.length > MAX_IMAGE_BYTES) return tooLarge(bytes.length);
  const mediaType = sniffImage(bytes);
  if (!mediaType) return `${name} is not a PNG, JPEG, GIF, or WebP image`;
  // Re-encoded, so whatever the client sent, the transcript holds clean base64.
  return {
    type: 'image',
    mediaType,
    data: Buffer.from(bytes).toString('base64'),
    attachment: { path: name },
  };
}

/**
 * Rough tokens an image costs. Providers charge by pixel area, up to about
 * this much for an image at their maximum size; the bytes say nothing useful.
 */
export const IMAGE_TOKENS = 1_600;

/** What a model without vision reads in an image's place. */
function placeholder(p: ImagePart): string {
  const what = p.attachment ? `image ${p.attachment.path}` : 'an image';
  return `[${what} is attached, but this model can't see images; ask the user to describe it or switch to a model with vision]`;
}

/**
 * Messages as a model without vision is sent them: each image becomes a note.
 * Deterministic, so a session that stays on such a model keeps its cache prefix.
 */
export function withoutImages(messages: Message[]): Message[] {
  if (!messages.some(hasImages)) return messages;
  return messages.map((m) =>
    hasImages(m) ? { ...m, parts: m.parts.map((p) => describeImages(p)) } : m,
  );
}

function describeImages(p: Part): Part {
  if (p.type === 'image') return { type: 'text', text: placeholder(p) };
  if (p.type === 'tool_result' && p.images?.length) {
    const { images, ...rest } = p;
    return { ...rest, content: [p.content, ...images.map(placeholder)].join('\n') };
  }
  return p;
}

export function hasImages(m: Message): boolean {
  return m.parts.some(
    (p) => p.type === 'image' || (p.type === 'tool_result' && !!p.images?.length),
  );
}
