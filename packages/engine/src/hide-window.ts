/**
 * Spawn options for every child process Switchback starts that the user
 * doesn't look at directly (commands, hooks, git, rg, clipboard helpers).
 *
 * On Windows a console program started by a process that has no console of
 * its own gets a new console window. The shared engine runs detached, and VS
 * Code starts the engine from a GUI process, so without this every
 * `powershell` or `.ps1` command flashes a window open. The sandbox's helper
 * already starts commands without one, which is why only unsandboxed commands
 * flashed. `windowsHide` does nothing on macOS and Linux.
 *
 * Don't use it for a program the user is meant to see, such as `$EDITOR`.
 */
export function hideWindow<T extends object>(options: T): T & { windowsHide: true } {
  return { ...options, windowsHide: true };
}
