import { bashTool } from './bash.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from './fs.ts';
import { taskTool } from './task.ts';
import type { Tool } from './tool.ts';

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
];

export function toolsFor(allowed: string[] | undefined): Tool[] {
  return allowed ? ALL_TOOLS.filter((t) => allowed.includes(t.name)) : ALL_TOOLS;
}
