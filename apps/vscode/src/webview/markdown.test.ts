import { beforeAll, expect, test } from 'bun:test';
import type { Window } from 'happy-dom';
import { installDom } from './test-dom.ts';

let renderMarkdown: (text: string) => string;
let window: Window;
let document: Window['document'];
beforeAll(async () => {
  // DOMPurify binds to the global window when first imported.
  window = installDom();
  document = window.document;
  ({ renderMarkdown } = await import('./markdown.ts'));
});

test('renders Markdown with code block actions', () => {
  const html = renderMarkdown('**Fix**: edit `a.ts`\n\n```ts\nconst x = 1 < 2;\n```');
  expect(html).toContain('<strong>Fix</strong>');
  expect(html).toContain('<code>a.ts</code>');
  expect(html).toContain('data-insert');
  expect(html).toContain('const x = 1 &lt; 2;');
});

test('model output cannot inject script', () => {
  const attacks = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '[click](javascript:alert(1))',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="#" onclick="alert(1)">x</a>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<a href="javascript:alert(1)">raw html link</a>',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '![pixel](javascript:alert(1))',
    'text <b onmouseover="alert(1)">bold</b> inline',
  ];
  for (const a of attacks) {
    // Inspect the DOM the webview would build, not the string: escaped text is fine.
    const el = document.createElement('div');
    el.innerHTML = renderMarkdown(a);
    expect(el.querySelectorAll('script, iframe, object, embed, img, style').length).toBe(0);
    for (const node of el.querySelectorAll('*')) {
      for (const attr of Array.from(node.attributes)) {
        expect(attr.name.startsWith('on')).toBe(false);
        expect(attr.name).not.toBe('style');
        if (attr.name === 'href' || attr.name === 'src')
          expect(attr.value).toMatch(/^(https?:|mailto:)/i);
      }
    }
  }
  expect(renderMarkdown('[docs](https://harville.ai/docs)')).toContain(
    'href="https://harville.ai/docs"',
  );
});
