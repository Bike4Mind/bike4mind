import { constants, setPriority } from 'node:os';

/**
 * Drop a just-spawned process group leader to below-normal priority (nice 10; the same constant
 * is BELOW_NORMAL on Windows). Children it starts from here on inherit it. Best effort: the
 * process may already have exited.
 */
export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Exited already, or the platform refused; the command still runs, at normal priority.
  }
}
