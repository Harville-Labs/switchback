/** Alt+↓ moves the transcript from the session to each of its subagents; alt+↑ comes back. */
import { childView, nextFocus, subagentList, type ViewState } from '@switchback/client';
import { useEffect, useState } from 'react';

export function useSubagentFocus(view: ViewState, sessionId: string) {
  /** The subagent shown in place of the session, if any. */
  const [focused, setFocused] = useState<string | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: another tab starts on its session
  useEffect(() => setFocused(undefined), [sessionId]);
  const row = focused ? subagentList(view).find((x) => x.id === focused)?.row : undefined;
  return {
    focused,
    row,
    /** What the transcript shows: the focused subagent's view, or the session's. */
    shown: (focused && childView(view, focused)) || view,
    next: () => setFocused((f) => nextFocus(view, f)),
    unfocus: () => setFocused(undefined),
  };
}
