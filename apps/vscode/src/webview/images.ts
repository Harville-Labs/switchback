/**
 * Images waiting to go with the next prompt: pasted into the composer or
 * dropped on it, shown as thumbnails above the input until sent or removed.
 * The engine checks each one's bytes; this only keeps what the browser says
 * is an image and what fits.
 */
import { MAX_IMAGE_BYTES } from '@switchback/protocol';
import { esc } from './markdown.ts';

export interface PendingImage {
  name: string;
  /** Base64, no `data:` prefix. */
  data: string;
  /** For the thumbnail. */
  src: string;
}

const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class PendingImages {
  private images: PendingImage[] = [];
  private pasted = 0;

  constructor(
    private readonly tray: HTMLElement,
    /** Something worth telling the user (an image too big, or not a kind we send). */
    private readonly notice: (text: string) => void,
    /** The tray changed (the send button may care). */
    private readonly changed: () => void = () => {},
  ) {
    tray.addEventListener('click', (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset.remove;
      if (i === undefined) return;
      this.images.splice(Number(i), 1);
      this.render();
    });
  }

  get count(): number {
    return this.images.length;
  }

  /** Files from a paste or drop; true when any were images (so the event is handled). */
  add(files: Iterable<File>): boolean {
    let any = false;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      any = true;
      if (!TYPES.has(file.type)) {
        this.notice(`${file.name || 'That image'} isn't a PNG, JPEG, GIF, or WebP image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        const mb = (n: number) => (n / 1e6).toFixed(1);
        this.notice(
          `${file.name || 'That image'} is ${mb(file.size)} MB; images can be at most ${mb(MAX_IMAGE_BYTES)} MB.`,
        );
        continue;
      }
      // Clipboard images are all called image.png; number them instead.
      const name = file.name && file.name !== 'image.png' ? file.name : `image ${++this.pasted}`;
      void base64(file).then((data) => {
        this.images.push({ name, data, src: `data:${file.type};base64,${data}` });
        this.render();
      });
    }
    return any;
  }

  /** Everything pending, for the prompt being sent; the tray empties. */
  take(): PendingImage[] {
    const taken = this.images;
    this.images = [];
    this.render();
    return taken;
  }

  private render(): void {
    this.tray.innerHTML = this.images
      .map(
        (img, i) =>
          `<div class="pending-image" title="${esc(img.name)}"><img src="${img.src}" alt="${esc(img.name)}"><button class="remove" data-remove="${i}" title="Remove" aria-label="Remove ${esc(img.name)}">✕</button></div>`,
      )
      .join('');
    this.changed();
  }
}

async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  // In slices: spreading a whole image into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
