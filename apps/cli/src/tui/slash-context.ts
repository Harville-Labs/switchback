/** What the TUI's slash commands work with (`slash.ts` and the files it splits into). */
import type {
  ChosenRole,
  SlashCommand,
  SwitchbackClient,
  TabsState,
  ViewState,
} from '@switchback/client';
import { addInfo } from '@switchback/client';
import type {
  InitializeResult,
  RoutePreference,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import type { ChoiceList } from './ChoicePicker.tsx';
import type { MouseInput } from './mouse.ts';
import type { ThemeName } from './theme.ts';

/** What a command can see and change in the app. */
export interface SlashContext {
  client: SwitchbackClient;
  init: InitializeResult;
  session: SessionSummary;
  view: ViewState;
  setView(update: (v: ViewState) => ViewState): void;
  setSession(s: SessionSummary): void;
  setRoute(route: RoutePreference): void;
  setReview(review: boolean | undefined): void;
  setUsage(u: UsageReport): void;
  /** Custom commands, for /help. */
  custom: readonly SlashCommand[];
  /** Sessions from the last /sessions, for `/resume <n>`. */
  listed: SessionSummary[];
  setListed(sessions: SessionSummary[]): void;
  /** Write raw bytes to the terminal (OSC 52 clipboard). */
  writeRaw(s: string): void;
  /** Show the session picker. */
  openPicker(): Promise<void>;
  /** Show the checkpoint picker. */
  openRewind(): Promise<void>;
  /** Show the current-model picker. */
  openModelPicker(role: ChosenRole): void;
  /** Show a list to pick a command's argument from. */
  openChoices(list: ChoiceList): void;
  /** Run setup (`/init`), as `switchback init` does. */
  openSetup(): void;
  /** The agent of the subagent shown in place of the session (Tab), if any. */
  focusedSubagent?: string;
  /** The open tabs and the sessions the dashboard knows about. */
  tabs: TabsState;
  openDashboard(): void;
  /** A new session in a new tab. */
  newTab(agent?: string): Promise<void>;
  /** Bring a session forward: its tab, or a new one if it isn't open here. */
  showSession(sessionId: string): Promise<void>;
  closeTab(sessionId: string): void;
  /** The color theme, and a way to change it (saved for next time). */
  theme: ThemeName;
  setTheme(name: ThemeName): void;
  /** Mouse reporting, which `/mouse` switches; absent when the TUI doesn't read the mouse. */
  mouse?: MouseInput;
  exit(): void;
}

export type Handler = (ctx: SlashContext, args: string[]) => Promise<void> | void;

export const say = (ctx: SlashContext, text: string) => ctx.setView((v) => addInfo(v, text));
