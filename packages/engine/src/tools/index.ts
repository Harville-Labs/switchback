import { bashTool } from './bash.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './fs.ts';
import { exitPlanModeTool } from './plan.ts';
import { taskTool } from './task.ts';
import type { Tool } from './tool.ts';

export { EXIT_PLAN_MODE } from './plan.ts';
export * from './tool.ts';

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
];

/**
 * An agent's tools in their fixed order. exit_plan_mode isn't a capability an
 * agent definition grants; it's offered to every top-level session.
 */
export function toolsFor(allowed: string[] | undefined, topLevel: boolean): Tool[] {
  return ALL_TOOLS.filter((t) =>
    t.name === exitPlanModeTool.name ? topLevel : !allowed || allowed.includes(t.name),
  );
}
