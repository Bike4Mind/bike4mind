import path from 'path';

const PLAN_MODE_DIR = '.b4m-cli/plans';

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
 * Whether a file write's target path is inside the plan-mode directory. Used to allow
 * incremental plan-file writes while plan mode blocks other writes. The path comes from the
 * tool descriptor's writePathArg (tools/gateway/toolPolicy.ts writePathOf).
 */
export function isWriteTargetingPlanFile(writePath: string | undefined, cwd: string = process.cwd()): boolean {
  if (!writePath) return false;
  const resolved = path.resolve(cwd, writePath);
  const planDir = getPlanModeFileDir(cwd);
  const rel = path.relative(planDir, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
