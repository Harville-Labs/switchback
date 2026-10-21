/** The app's own keys, whatever has focus: scrolling, tabs, the permission mode, and shortcuts. */
import { cycleTab, switchTab, type TabsState, tabAt } from '@switchback/client';
import { useInput } from 'ink';

export interface AppKeys {
  tabs: TabsState;
  setTabs: (update: (t: TabsState) => TabsState) => void;
  page: (direction: -1 | 1) => void;
  /** A picker or the dashboard is open and handles its own keys. */
  modal: boolean;
  /** A permission or escalation prompt is waiting for an answer. */
  prompting: boolean;
  openDashboard: () => void;
  toggleExpanded: () => void;
  escalate: () => void;
  nextMode: () => void;
}

export function useAppKeys(k: AppKeys): void {
  useInput((ch, key) => {
    // Scrolling works whatever has focus.
    if (key.pageUp) return k.page(-1);
    if (key.pageDown) return k.page(1);
    // The pickers, the prompts, and the input handle their own keys, Ctrl+C included.
    if (k.modal) return;
    // Tabs switch even while a prompt waits: the prompt stays with its tab.
    if (key.ctrl && ch === 't') return k.openDashboard();
    // Terminals send ctrl+tab only with kitty's keyboard protocol (index.tsx
    // asks for it) or xterm's modifyOtherKeys (mouse.ts translates that), and
    // only when the terminal hasn't bound it to its own tabs.
    if (key.tab && key.ctrl) return k.setTabs((t) => cycleTab(t, key.shift ? -1 : 1));
    if (key.meta && /^[1-9]$/.test(ch)) {
      const tab = tabAt(k.tabs, Number(ch));
      if (tab) k.setTabs((t) => switchTab(t, tab.session.id));
      return;
    }
    if (key.meta && (key.leftArrow || key.rightArrow))
      return k.setTabs((t) => cycleTab(t, key.leftArrow ? -1 : 1));
    if (k.prompting) return;
    if (key.ctrl && ch === 'o') return k.toggleExpanded();
    if (key.meta && key.upArrow) return k.escalate();
    if (key.tab && key.shift) k.nextMode();
  });
}
