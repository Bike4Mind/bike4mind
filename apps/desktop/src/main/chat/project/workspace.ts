import { randomBytes } from 'node:crypto';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from './branchName';
import type { WorktreeEntry } from './git';
import { branchExists, containerDirectory, fetchRemoteFor, git, listWorktrees, resolveBaseRef } from './git';

/**
 * A branch's folder name under the app's worktree root.
 *
 * '/' becomes '+' so `fix/some-branch` is one directory entry rather than a nested pair, which
 * is the convention in the user's ~/.config/b4m/worktree.zsh.
 *
 * Nothing predicts a path from this any more, and nothing should: the branch a session runs on
 * is cut here, with a random suffix, so the only truthful answer before resolution is that
 * there is not one yet. The UI names the worktree from `project.workingDirectory` once it has
 * been resolved - see WorkingDirectoryLine and the worktree chip's tooltip.
 */
export function worktreeFolderName(branch: string): string {
  return branch.replaceAll('/', '+');
}

/** The app's own folder in a project container, beside `.claude` and `.manifold`. */
const APP_DIRECTORY = '.b4m';

/** Namespaces the branches this app cuts, so they read as such in `git branch`. */
const BRANCH_PREFIX = 'b4m/';

/** Three bytes of hex: short enough to read, wide enough that two sessions do not collide. */
const SUFFIX_BYTES = 3;

export type WorkspaceOutcome = 'created' | 'reused';

/**
 * What a session asks for when it wants somewhere isolated to run.
 *
 * `base` and `branch` are two different things and the split is the whole point: `base` is
 * what the user picked in the chip menu, and the session gets a branch of its OWN cut from it.
 * `branch` is that own branch once it exists, handed back on every later resolution so the
 * session lands in the worktree it already has rather than cutting another.
 */
export interface WorkspaceRequest {
  /** The branch the user picked. Empty when they picked none. */
  base?: string;
  /** This session's own branch, when it has one. Set, nothing is derived and nothing is cut. */
  branch?: string;
  /** Seed for a derived branch name - the session's title. */
  name?: string;
  /** Told the branch as soon as it is decided, ahead of the fetch and checkout that take the time. */
  onBranch?: (branch: string) => void;
}

export interface WorkspaceResolution {
  /** Where the session's tools will run. */
  workingDirectory: string;
  /**
   * The branch checked out there, which is NOT the base it was cut from. Persist it on the
   * session: handing it back is what makes the next resolution reuse this worktree.
   */
  branch: string;
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
 * Where this app's worktrees live: `<container>/.b4m/worktrees`, its own folder rather than the
 * container itself.
 *
 * Beside `.claude/worktrees` and `.manifold/worktrees`, which already solve this in the same
 * containers. Two things made the flat layout wrong. It collided with the user's own folders -
 * choosing `main` resolved to `<container>/main`, their primary checkout - and on an ordinary
 * clone `containerDirectory` is the REPOSITORY, so every worktree became an untracked sibling
 * in the repo root. Nothing the app creates now shares a parent with anything it did not.
 */
export function appWorktreeRoot(container: string): string {
  return join(container, APP_DIRECTORY, 'worktrees');
}

/**
 * Make the root, and keep it out of the user's index.
 *
 * On an ordinary clone this directory sits inside a tracked working tree, so without the
 * ignore every app worktree shows up as untracked noise in `git status`. The '*' file ignores
 * the folder it is in and is written INSIDE the app's own directory - the repository's own
 * .gitignore is the user's file and is never touched.
 */
async function ensureWorktreeRoot(container: string): Promise<void> {
  await mkdir(appWorktreeRoot(container), { recursive: true });
  const ignore = join(container, APP_DIRECTORY, '.gitignore');
  try {
    await stat(ignore);
  } catch {
    await writeFile(ignore, '*\n', 'utf8');
  }
}

/**
 * The branch a session cuts for itself.
 *
 * The random suffix carries the uniqueness, not the title: titles are generated, repeat across
 * conversations, and two sessions started from the same base would otherwise ask for the same
 * branch - which is refused rather than resolved, leaving the user a dead end to edit their way
 * out of. 'session' covers a conversation that has not been named yet.
 */
export function sessionBranchName(name?: string): string {
  const slug = slugify(name ?? '') || 'session';
  return `${BRANCH_PREFIX}${slug}-${randomBytes(SUFFIX_BYTES).toString('hex')}`;
}

/**
 * What to cut a new branch from, given the branch the user picked.
 *
 * Prefers the base's remote-tracking ref, but only once it is proven to contain the local one.
 * A long-lived local `main` drifts hundreds of commits behind `origin/main` without anyone
 * noticing, and a branch cut from it starts life needing a merge nobody asked for; the ancestor
 * check is what keeps that from costing unpushed work on a branch the user has been committing
 * to. With no base picked this falls back to resolveBaseRef, matching the default in the user's
 * `worktree` command.
 */
async function baseRefFor(directory: string, base: string): Promise<string> {
  if (!base) {
    const fallback = await resolveBaseRef(directory);
    await fetchRemoteFor(directory, fallback);
    return fallback;
  }
  const remote = `origin/${base}`;
  try {
    await fetchRemoteFor(directory, remote);
    await git(directory, ['rev-parse', '--verify', '--quiet', `${remote}^{commit}`]);
    await git(directory, ['merge-base', '--is-ancestor', base, remote]);
    return remote;
  } catch {
    return base;
  }
}

/**
 * The worktree a Code session with the workspace toggle ON runs in, creating one only when the
 * session does not already have it.
 *
 * The branch the user picks is a BASE, not a target: the session is given a branch of its own,
 * cut from it. Picking a branch something else already has checked out used to hand back that
 * checkout, so "worktree" claimed an isolation the session did not get - and the one branch a
 * user is most likely to pick, `main`, is the one always already checked out. Claude Code's own
 * entries in these containers show the same shape: a folder named for a branch nothing else
 * holds.
 *
 * One rule covers both halves of what the chip menu can send. A name that IS a branch is a base
 * and the session's branch is derived; a name that is NOT names the session's branch, which is
 * then cut from the default base. Either way the session ends up alone on a branch of its own.
 *
 * Idempotence is the caller's half: `branch` comes back in the resolution and goes onto the
 * session, and handing it in again short-circuits both the derivation and the cut. Without it
 * every restart and every re-read of a project would cut another branch.
 *
 * Nothing here writes to a '../' path, which would scatter sibling folders that read as
 * separate projects, and nothing touches a worktree this app did not create: a path already
 * occupied is refused, never adopted or cleared.
 */
export async function resolveWorkspace(
  projectDirectory: string,
  request: WorkspaceRequest
): Promise<WorkspaceResolution> {
  const registered = await listWorktrees(projectDirectory);
  const base = (request.base ?? '').trim();

  let branch = (request.branch ?? '').trim();
  let cutFrom = '';
  if (!branch) {
    // The single lookup that decides which half of the rule applies.
    if (base && (await branchExists(projectDirectory, base))) {
      cutFrom = base;
      branch = sessionBranchName(request.name);
    } else {
      branch = base || sessionBranchName(request.name);
    }
  }

  request.onBranch?.(branch);

  // Keyed on the session's OWN branch, so this hits only for a worktree this session already
  // has - never for the user's checkout of the base.
  const existingForBranch = registered.find(entry => entry.branch === branch);
  if (existingForBranch) return { workingDirectory: existingForBranch.path, branch, outcome: 'reused' };

  const container = await containerDirectory(projectDirectory);
  const path = join(appWorktreeRoot(container), worktreeFolderName(branch));

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

  await ensureWorktreeRoot(container);

  if (await branchExists(projectDirectory, branch)) {
    await git(projectDirectory, ['worktree', 'add', path, branch]);
  } else {
    const from = await baseRefFor(projectDirectory, cutFrom);
    // --no-track for the reason the shell helper gives: a feature branch should not track the
    // base it forked from, or a later `git push` would aim at the wrong ref.
    await git(projectDirectory, ['worktree', 'add', '--no-track', '-b', branch, path, from]);
  }

  return { workingDirectory: path, branch, outcome: 'created' };
}
