/**
 * Markdown for finished assistant messages in the chat view. Model output is
 * untrusted: raw HTML is escaped, links are limited to http(s)/mailto, the
 * result also goes through DOMPurify, and the webview's CSP blocks scripts
 * regardless. Code blocks get Copy / Insert buttons.
 */
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SAFE_URL = /^(?:https?:|mailto:)/i;

const marked = new Marked({
  gfm: true,
  renderer: {
    // Raw HTML in model output is shown as text, never rendered. Every tag in
    // the result comes from these renderers, so safety doesn't hinge on the
    // sanitizer (which stays as a second layer).
    html({ text }) {
      return esc(text);
    },
    // Images would load remote content; show them as links instead.
    image({ href, text }) {
      const label = esc(text || href);
      return SAFE_URL.test(href) ? `<a href="${esc(href)}">${label}</a>` : label;
    },
    // Only web and mail links survive; anything else renders as plain text.
    link({ href, text }) {
      return SAFE_URL.test(href) ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
    },
    code({ text, lang }) {
      const label = lang ? esc(lang.split(/\s/)[0] ?? '') : 'code';
      return `<div class="code"><div class="code-bar"><span>${label}</span><span><button class="link" data-copy>Copy</button><button class="link" data-insert>Insert</button></span></div><pre><code>${esc(text)}</code></pre></div>`;
    },
  },
});

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let html: string;
  try {
    html = DOMPurify.sanitize(marked.parse(text) as string, {
      FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
      ALLOWED_URI_REGEXP: SAFE_URL,
    });
  } catch {
    html = `<p>${esc(text)}</p>`;
  }
  if (cache.size > 300) cache.clear();
  cache.set(text, html);
  return html;
}
