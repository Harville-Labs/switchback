import { bashOutputTool, bashTool, killShellTool } from './bash.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './fs.ts';
import { exitPlanModeTool } from './plan.ts';
import { skillTool } from './skill.ts';
import { taskTool } from './task.ts';
import { todoTool } from './todo.ts';
import type { Tool } from './tool.ts';
import { webFetchTool, webSearchTool } from './web.ts';

export { EXIT_PLAN_MODE } from './plan.ts';
export { type BackgroundShell, CommandRunner, type CommandSettings } from './process.ts';
export { installSandbox, sandboxInstalled, uninstallSandbox } from './sandbox.ts';
export * from './tool.ts';
export type { WebSettings } from './web.ts';

/** Fixed order: the tool list is part of the prompt-cache prefix. */
export const ALL_TOOLS: Tool[] = [
  readTool,
  globTool,
  grepTool,
  editTool,
  writeTool,
  bashTool,
  taskTool,
  exitPlanModeTool,
  bashOutputTool,
  killShellTool,
  webFetchTool,
  webSearchTool,
  todoTool,
  skillTool,
];

/** Tools that come with another: an agent that may run bash may also read and stop what it started. */
const COMPANIONS: Record<string, string> = {
  [bashOutputTool.name]: bashTool.name,
  [killShellTool.name]: bashTool.name,
};

/**
 * An agent's tools in their fixed order. Some aren't capabilities an agent
 * definition grants: exit_plan_mode is offered to every top-level session,
 * and the todo checklist and skills to every session.
 */
export function toolsFor(allowed: string[] | undefined, topLevel: boolean): Tool[] {
  return ALL_TOOLS.filter((t) => {
    if (t.name === exitPlanModeTool.name) return topLevel;
    if (t.name === todoTool.name || t.name === skillTool.name) return true;
    const needs = COMPANIONS[t.name] ?? t.name;
    return !allowed || allowed.includes(needs);
  });
}
