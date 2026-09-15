import path from 'path';

const PLAN_MODE_DIR = '.b4m-cli/plans';

const PATH_TOOLS = new Set(['create_file', 'edit_local_file', 'delete_file']);

/**
 * Directory plan-mode artifacts are written to (under the working directory).
 * Writes to paths under this directory are permitted while plan mode is active.
 */
export function getPlanModeFileDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, PLAN_MODE_DIR);
}

/**
 * Default plan file for the current session. Sessions can override this if needed.
 */
export function getPlanModeFilePath(sessionId: string, cwd: string = process.cwd()): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getPlanModeFileDir(cwd), `plan-${safeId}.md`);
}

/**
 * Whether a write/edit/delete tool call targets a path inside the plan-mode directory.
 * Used to allow incremental plan-file writes while plan mode blocks other writes.
 */
export function isWriteTargetingPlanFile(toolName: string, args: unknown, cwd: string = process.cwd()): boolean {
  if (!PATH_TOOLS.has(toolName)) return false;
  const argPath = (args as { path?: unknown })?.path;
  if (typeof argPath !== 'string' || argPath.length === 0) return false;
  const resolved = path.resolve(cwd, argPath);
  const planDir = getPlanModeFileDir(cwd);
  const rel = path.relative(planDir, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
