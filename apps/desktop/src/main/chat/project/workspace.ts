import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorktreeEntry } from './git';
import { branchExists, containerDirectory, fetchRemoteFor, git, listWorktrees, resolveBaseRef } from './git';

/**
 * A branch's folder name in the container directory.
 *
 * '/' becomes '+' so `fix/some-branch` is one directory entry rather than a nested pair, which
 * is the convention in the user's ~/.config/b4m/worktree.zsh. Kept as a pure function because
 * it is also how the UI predicts the path before anything is created.
 */
export function worktreeFolderName(branch: string): string {
  return branch.replaceAll('/', '+');
}

export type WorkspaceOutcome = 'created' | 'reused';

export interface WorkspaceResolution {
  /** Where the session's tools will run. */
  workingDirectory: string;
  outcome: WorkspaceOutcome;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The registered worktree sitting at `path`, if any.
 *
 * Both sides go through realpath first: git reports resolved paths, while `path` is built by
 * join from whatever the user picked, so /var vs /private/var and a differently-cased parent
 * folder would each defeat a plain string compare on macOS.
 */
async function registeredAt(entries: readonly WorktreeEntry[], path: string): Promise<WorktreeEntry | null> {
  const wanted = await canonical(path);
  if (!wanted) return null;
  for (const entry of entries) {
    if ((await canonical(entry.path)) === wanted) return entry;
  }
  return null;
}

async function canonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The worktree a Code session with the workspace toggle ON should run in, creating it only if
 * there is not already one for that branch.
 *
 * Layout is the user's, not git's default: worktrees live INSIDE the project's own container
 * directory (the parent of the shared git dir), one folder per branch. Nothing here ever
 * writes to a '../' path, which would scatter sibling folders that read as separate projects.
 *
 * Reuse is checked two ways on purpose. A worktree already at the expected path is the common
 * case; one registered for the same branch at a DIFFERENT path is the case that matters,
 * because git allows a branch to be checked out in exactly one worktree and `worktree add`
 * would fail against it. That second lookup is also what makes selecting the branch the main
 * checkout is already on resolve to the main checkout instead of erroring - the resolved path
 * is surfaced to the user, so "isolated" is never claimed when it is not true.
 *
 * When neither lookup hits, what is at the path still has to be told apart. A folder git has
 * never heard of and a worktree that has since been switched to another branch are the same
 * stat() but opposite remedies: the first is the user's to move aside, while moving the second
 * with `mv` would strand git's registration on a path that no longer exists.
 */
export async function resolveWorkspace(projectDirectory: string, branch: string): Promise<WorkspaceResolution> {
  const registered = await listWorktrees(projectDirectory);

  const existingForBranch = registered.find(entry => entry.branch === branch);
  if (existingForBranch) return { workingDirectory: existingForBranch.path, outcome: 'reused' };

  const container = await containerDirectory(projectDirectory);
  const path = join(container, worktreeFolderName(branch));

  const occupant = await registeredAt(registered, path);
  if (occupant) {
    const holds = occupant.branch ? `the branch ${occupant.branch}` : 'a detached HEAD';
    throw new Error(
      `${path} is a git worktree holding ${holds}, not ${branch}. Pick a different branch for this ` +
        `session, or move that worktree with 'git worktree move' - plain mv would leave git ` +
        `pointing at a path that no longer exists.`
    );
  }

  // Something is at the path but git does not know it as a worktree. Refusing beats both
  // clobbering it and adopting a directory whose contents nobody has vouched for.
  if (await directoryExists(path)) {
    throw new Error(`${path} already exists but is not a git worktree. Move it aside, or pick a different branch.`);
  }

  if (await branchExists(projectDirectory, branch)) {
    await git(projectDirectory, ['worktree', 'add', path, branch]);
  } else {
    const base = await resolveBaseRef(projectDirectory);
    await fetchRemoteFor(projectDirectory, base);
    // --no-track for the reason the shell helper gives: a feature branch should not track the
    // base it forked from, or a later `git push` would aim at the wrong ref.
    await git(projectDirectory, ['worktree', 'add', '--no-track', '-b', branch, path, base]);
  }

  return { workingDirectory: path, outcome: 'created' };
}
