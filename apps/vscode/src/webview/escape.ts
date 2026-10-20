/**
 * Escaping for HTML, apart from the Markdown renderer so that modules needing
 * only this don't load DOMPurify, which binds to whatever window exists when
 * it's first imported.
 */

/** Escape text for HTML: model output is never markup. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
