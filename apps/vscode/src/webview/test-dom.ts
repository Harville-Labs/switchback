/**
 * A browser DOM for webview tests, installed as globals and removed after the
 * file's tests. Every test file shares one process: a leftover `window` makes
 * later code think it's in a browser (the OpenAI SDK then refuses to run).
 */
import { afterAll } from 'bun:test';
import { Window } from 'happy-dom';

export function installDom(extra: Record<string, unknown> = {}): Window {
  const window = new Window();
  const globals = { window, document: window.document, ...extra };
  Object.assign(globalThis, globals);
  afterAll(() => {
    for (const name of Object.keys(globals)) delete (globalThis as Record<string, unknown>)[name];
  });
  return window;
}
