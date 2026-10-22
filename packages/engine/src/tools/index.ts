import { bashOutputTool, bashTool, killShellTool } from './bash.ts';
import { docsTool } from './docs.ts';
import { escalateTool } from './escalate.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './fs.ts';
import { goalTool } from './goal.ts';
import { mergeWorktreeTool } from './merge.ts';
import { exitPlanModeTool } from './plan.ts';
import { skillTool } from './skill.ts';
import { configTool, modelsTool, setConfigTool, setRolesTool } from './switchback.ts';
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
  docsTool,
  mergeWorktreeTool,
  escalateTool,
  goalTool,
  modelsTool,
  configTool,
  setConfigTool,
  setRolesTool,
];

/** Tools that come with another: an agent that may run bash may also read and stop what it started. */
const COMPANIONS: Record<string, string> = {
  [bashOutputTool.name]: bashTool.name,
  [killShellTool.name]: bashTool.name,
  // Only an agent that can start isolated subagents has their branches to merge.
  [mergeWorktreeTool.name]: taskTool.name,
  // Changing a setting is an edit to a config file.
  [setConfigTool.name]: editTool.name,
};

/** Offered only to top-level sessions: they act on the session the user is in. */
const TOP_LEVEL = [exitPlanModeTool.name, goalTool.name, setRolesTool.name];

/** A model with less context than this (tokens) gets the small tool list. */
export const SMALL_CONTEXT = 32_000;

/**
 * Left out for small models, whose window the full list would crowd. Each is
 * something a small model can escalate for, or the user can do with a command
 * (/ladder, /models, /reload after an edit).
 */
const LARGE_CONTEXT_ONLY = [
  mergeWorktreeTool.name,
  modelsTool.name,
  configTool.name,
  setConfigTool.name,
  setRolesTool.name,
];

/** The tools a model with this context window is offered, in the same order. */
export function forContext<T extends { name: string }>(tools: T[], contextWindow: number): T[] {
  if (contextWindow >= SMALL_CONTEXT) return tools;
  return tools.filter((t) => !LARGE_CONTEXT_ONLY.includes(t.name));
}

/**
 * An agent's tools in their fixed order. Some aren't capabilities an agent
 * definition grants: exit_plan_mode, goal, and set_roles are offered to every
 * top-level session, and the todo checklist, skills, Switchback's docs, escalate,
 * and reading models and config to every session.
 */
export function toolsFor(allowed: string[] | undefined, topLevel: boolean): Tool[] {
  const always = [
    todoTool.name,
    skillTool.name,
    docsTool.name,
    escalateTool.name,
    modelsTool.name,
    configTool.name,
  ];
  return ALL_TOOLS.filter((t) => {
    // Offered whether or not a goal is active, so the tool list (cache prefix) stays the same.
    if (TOP_LEVEL.includes(t.name)) return topLevel;
    if (always.includes(t.name)) return true;
    const needs = COMPANIONS[t.name] ?? t.name;
    return !allowed || allowed.includes(needs);
  });
}
