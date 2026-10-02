import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Long enough for a cold `git fetch` on a large repo, short enough not to hang the dialog. */
const GIT_TIMEOUT_MS = 20_000;

const MAX_GIT_OUTPUT_BYTES = 4_000_000;

/**
 * A git invocation that failed, carrying git's own stderr.
 *
 * These commands are driven by the USER (picking a project in a native dialog), never by the
 * model, so unlike the tool refusals in tools/paths.ts there is nothing to withhold: the
 * message is shown to the person who chose the directory.
 */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    stderr: string
  ) {
    super(stderr.trim() || `git ${args.join(' ')} failed`);
    this.name = 'GitError';
  }
}

export async function git(directory: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: directory,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
  } catch (err) {
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string' ? (err as { stderr: string }).stderr : '';
    throw new GitError(args, stderr || (err instanceof Error ? err.message : ''));
  }
}

/** True only for a real work tree: a bare repo answers 'false' and is not somewhere to run tools. */
export async function isGitRepository(directory: string): Promise<boolean> {
  try {
    return (await git(directory, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(directory: string): Promise<string | null> {
  try {
    const name = (await git(directory, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    // Detached HEAD answers with the literal string, which is not a branch anyone can check out.
    return name && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

/** Local branches, the checked-out one first so the dialog opens on the likely answer. */
export async function listBranches(directory: string): Promise<string[]> {
  const stdout = await git(directory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const branches = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const head = await currentBranch(directory);
  if (!head || !branches.includes(head)) return branches;
  return [head, ...branches.filter(branch => branch !== head)];
}

export async function branchExists(directory: string, branch: string): Promise<boolean> {
  try {
    await git(directory, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The directory worktrees are created beside: the parent of the shared git dir.
 *
 * This is `_wt_container` from the user's ~/.config/b4m/worktree.zsh, reimplemented rather
 * than shelled out to, because a packaged app cannot assume that file exists. For the
 * bare-repo layout the shared git dir is <container>/.bare, so this is <container>; for an
 * ordinary clone it is <repo>/.git, so worktrees land beside the checkout inside the repo
 * folder - which is what that script does too.
 */
export async function containerDirectory(directory: string): Promise<string> {
  const common = (await git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (!common) throw new GitError(['rev-parse', '--git-common-dir'], 'git named no common directory');
  return dirname(common);
}

/**
 * What to call the project in the sidebar.
 *
 * Not simply the basename: in the bare-repo layout the directory a user picks is
 * <container>/main, so every project would be called "main". The container is the thing with
 * the project's actual name, and it differs from the directory only in that layout - for an
 * ordinary clone the two are the same folder, and the basename is right.
 *
 * Falls back to the basename whenever git cannot be asked, which covers a plain directory that
 * is not a repository at all.
 */
export async function projectDisplayName(directory: string): Promise<string> {
  try {
    const container = await containerDirectory(directory);
    return basename(container === directory ? directory : container);
  } catch {
    return basename(directory);
  }
}

export interface WorktreeEntry {
  path: string;
  /** Absent for a detached-HEAD worktree. */
  branch?: string;
}

/**
 * True when `path` is itself a git directory (HEAD, objects/ and refs/), as <container>/.bare is.
 * Checked on disk rather than through git: a bare repo that also carries core.bare=false in a
 * shared config answers `rev-parse` as if it were a work tree.
 */
export async function isGitDirectory(path: string): Promise<boolean> {
  try {
    const [head, objects, refs] = await Promise.all([
      stat(join(path, 'HEAD')),
      stat(join(path, 'objects')),
      stat(join(path, 'refs')),
    ]);
    return head.isFile() && objects.isDirectory() && refs.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Checked-out worktrees only. The bare repo's own entry is dropped: it is not somewhere to run
 * tools, and with core.bare unset in a shared config git lists it with a `branch` line, which
 * made it win a lookup for the branch the main worktree actually holds.
 */
export async function listWorktrees(directory: string): Promise<WorktreeEntry[]> {
  const stdout = await git(directory, ['worktree', 'list', '--porcelain']);
  const entries: (WorktreeEntry & { bare?: boolean })[] = [];
  let current: (WorktreeEntry & { bare?: boolean }) | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line === 'bare' && current) {
      current.bare = true;
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice('branch refs/heads/'.length).trim();
    } else if (line === '' && current) {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);

  const checkouts: WorktreeEntry[] = [];
  for (const { bare, ...entry } of entries) {
    if (bare || (await isGitDirectory(entry.path))) continue;
    checkouts.push(entry);
  }
  return checkouts;
}

/**
 * What a new branch forks from: origin/main when it resolves, matching the default in the
 * user's `worktree` command, and otherwise whatever HEAD is - a repo with no origin still has
 * to produce a usable branch rather than an error the user cannot act on.
 */
export async function resolveBaseRef(directory: string): Promise<string> {
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      await git(directory, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next one; a repo with no remote falls through to HEAD.
    }
  }
  return 'HEAD';
}

/** Best-effort freshening so a new branch forks from an up-to-date base, as the shell helper does. */
export async function fetchRemoteFor(directory: string, baseRef: string): Promise<void> {
  const remote = baseRef.includes('/') ? baseRef.split('/')[0] : null;
  if (!remote) return;
  try {
    await git(directory, ['fetch', '--quiet', remote]);
  } catch {
    // Offline, or no such remote. Branching from the stale ref beats refusing to start.
  }
}
