import { basename, resolve } from 'node:path';
import type { ProjectInspection } from '@shared/chat';
import {
  branchCheckouts,
  currentBranch,
  isGitRepository,
  listBranches,
  projectDisplayName,
  unusableProjectReason,
} from './git';

/**
 * What a folder offers a new Code session: whether it is a repository, its branches, and why it
 * cannot ground one when it cannot. Read-only git calls, so it is not gated.
 */
export async function inspectProject(directory: string): Promise<ProjectInspection> {
  const resolved = resolve(directory);
  if (!(await isGitRepository(resolved))) {
    const base = {
      directory: resolved,
      name: basename(resolved),
      isRepository: false,
      branches: [],
      currentBranch: null,
    };
    const refusal = await unusableProjectReason(resolved);
    return refusal ? { ...base, refusal } : base;
  }
  const base = { directory: resolved, name: await projectDisplayName(resolved) };
  try {
    // The marks are an aid, not the list: a worktree listing git cannot answer leaves the
    // branches standing, and a toggle-off pick is still checked against git in main.
    const [branches, head, checkedOutElsewhere] = await Promise.all([
      listBranches(resolved),
      currentBranch(resolved),
      branchCheckouts(resolved).catch(() => ({})),
    ]);
    return { ...base, isRepository: true, branches, currentBranch: head, checkedOutElsewhere };
  } catch (err) {
    return {
      ...base,
      isRepository: true,
      branches: [],
      currentBranch: null,
      error: err instanceof Error ? err.message : 'Could not read this repository.',
    };
  }
}
