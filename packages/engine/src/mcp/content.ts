/**
 * MCP content (tool results, resources, prompt messages) as transcript text
 * and images. Images are checked like any other (by their bytes, within the
 * size limit); other binary content is described rather than dropped
 * silently.
 */
import type { ImagePart } from '@switchback/protocol';
import { pastedImage } from '../images.ts';

export interface Converted {
  text: string;
  images: ImagePart[];
}

interface ContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

/** Tool result or prompt message content. `label` names images that have no name of their own. */
export function fromContent(content: unknown, label: string): Converted {
  if (!Array.isArray(content)) return { text: '', images: [] };
  const text: string[] = [];
  const images: ImagePart[] = [];
  for (const c of content as ContentItem[]) {
    if (c.type === 'text') text.push(c.text ?? '');
    else if (c.type === 'image' && c.data) {
      const image = pastedImage(`${label} image ${images.length + 1}`, c.data);
      if (typeof image === 'string') text.push(`[image omitted: ${image}]`);
      else images.push(image);
    } else if (c.type === 'resource') {
      const r = fromResource(c.resource ?? {}, c.resource?.uri ?? label);
      text.push(r.text);
      images.push(...r.images);
    } else if (c.type === 'resource_link') text.push(`[resource ${c.uri ?? ''}]`);
    else
      text.push(`[${c.type ?? 'unknown'} content${c.mimeType ? ` (${c.mimeType})` : ''} omitted]`);
  }
  return { text: text.filter(Boolean).join('\n'), images };
}

/** One resource's contents: text as text, an image as an image, other binaries described. */
export function fromResource(
  r: { uri?: string; text?: string; blob?: string; mimeType?: string },
  name: string,
): Converted {
  if (typeof r.text === 'string') return { text: r.text, images: [] };
  if (r.blob && r.mimeType?.startsWith('image/')) {
    const image = pastedImage(name, r.blob);
    return typeof image === 'string'
      ? { text: `[${name}: ${image}]`, images: [] }
      : { text: '', images: [image] };
  }
  return { text: `[${name}: ${r.mimeType ?? 'binary'} content omitted]`, images: [] };
}
