/**
 * Clicks on what's drawn: a choice, a picker row, a key hint. The full-screen
 * TUI draws from the terminal's top-left corner, so a box's place on screen is
 * its layout offset summed up through its parents, read when the click comes
 * rather than tracked on every render.
 */
import { Box, type DOMElement } from 'ink';
import { createContext, type ReactNode, useContext, useEffect, useRef } from 'react';
import type { MouseInput } from './mouse.ts';

export const MouseContext = createContext<MouseInput | undefined>(undefined);

/** Whether a 1-based terminal column and row fall inside `element`. */
export function under(element: DOMElement, x: number, y: number): boolean {
  const size = element.yogaNode?.getComputedLayout();
  if (!size) return false;
  let left = 1;
  let top = 1;
  for (let node: DOMElement | undefined = element; node; node = node.parentNode) {
    const layout = node.yogaNode?.getComputedLayout();
    left += layout?.left ?? 0;
    top += layout?.top ?? 0;
  }
  return x >= left && x < left + size.width && y >= top && y < top + size.height;
}

/** Its children, and `onClick` when the left button is pressed over them. */
export function Clickable({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  const mouse = useContext(MouseContext);
  const ref = useRef<DOMElement>(null);
  const handler = useRef(onClick);
  handler.current = onClick;
  useEffect(
    () =>
      mouse?.onClick((x, y) => {
        if (ref.current && under(ref.current, x, y)) handler.current();
      }),
    [mouse],
  );
  return <Box ref={ref}>{children}</Box>;
}
