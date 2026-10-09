import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { BranchCheckout } from '@shared/chat';

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
    super(readableGitMessage(stderr) || `git ${args.join(' ')} failed`);
    this.name = 'GitError';
  }
}

/**
 * git's stderr as a sentence for the person reading the chip row: the `fatal:`/`error:` tags
 * dropped and `hint:` lines left out, since they name commands to type into a terminal the user
 * is not in. What git actually says is kept word for word.
 */
export function readableGitMessage(stderr: string): string {
  return stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^hint:/i.test(line))
    .map(line => line.replace(/^(fatal|error|warning):\s*/i, ''))
    .join(' ')
    .trim();
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

/**
 * The branch checked out in `directory`, for a directory that is a work tree.
 *
 * The work-tree check is what makes this agree with `isGitRepository`, and it is not
 * redundant with the rev-parse beside it: a worktree CONTAINER holds the shared git dir
 * without being a checkout, so asking it for HEAD answers for the BARE repo - a branch no
 * session is on, returned with every appearance of being the right one. Both facts come from
 * one invocation so the answer cannot be assembled out of two different moments.
 */
export async function currentBranch(directory: string): Promise<string | null> {
  try {
    const [workTree, name] = (await git(directory, ['rev-parse', '--is-inside-work-tree', '--abbrev-ref', 'HEAD']))
      .split('\n')
      .map(line => line.trim());
    if (workTree !== 'true') return null;
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

/** One record of `git worktree list --porcelain`, flags included. */
export interface PorcelainWorktree extends WorktreeEntry {
  bare?: boolean;
  /** Registered, but its folder is gone. git still refuses to check its branch out elsewhere. */
  prunable?: boolean;
}

export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const entries: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (!current) {
      continue;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'prunable' || line.startsWith('prunable ')) {
      current.prunable = true;
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length).trim();
    } else if (line === '') {
      entries.push(current);
      current = null;
    }
  }
  if (current) entries.push(current);
  return entries;
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
  const entries = parseWorktreePorcelain(await git(directory, ['worktree', 'list', '--porcelain']));
  const checkouts: WorktreeEntry[] = [];
  for (const { path, branch, bare } of entries) {
    if (bare || (await isGitDirectory(path))) continue;
    checkouts.push(branch ? { path, branch } : { path });
  }
  return checkouts;
}

/**
 * Every local branch checked out in a worktree other than `directory`, from ONE listing.
 *
 * Read alongside the branch list so the menu can mark them without a git call per branch. A
 * prunable entry is kept: git refuses to switch to its branch exactly as it does for a live one.
 * Only the first record is checked on disk for being the bare repo, because git always lists
 * the main worktree - or the bare repo standing in for it - first.
 */
export async function branchCheckouts(directory: string): Promise<Record<string, BranchCheckout>> {
  const entries = parseWorktreePorcelain(await git(directory, ['worktree', 'list', '--porcelain']));
  const own = await samePathAs(directory);
  const checkouts: [string, BranchCheckout][] = [];
  for (const [index, entry] of entries.entries()) {
    if (!entry.branch || entry.bare || own(entry.path)) continue;
    if (index === 0 && (await isGitDirectory(entry.path))) continue;
    checkouts.push([entry.branch, entry.prunable ? { path: entry.path, prunable: true } : { path: entry.path }]);
  }
  // fromEntries defines own keys, so a branch named `__proto__` is kept rather than swallowed.
  return Object.fromEntries(checkouts);
}

/**
 * A matcher for `directory` that tolerates the /var vs /private/var split on macOS: git reports
 * resolved paths, while the folder handed in is whatever the picker or the store held.
 */
async function samePathAs(directory: string): Promise<(path: string) => boolean> {
  const names = new Set([resolve(directory)]);
  try {
    names.add(await realpath(directory));
  } catch {
    // Gone or unreadable: the plain resolve is all there is to match on.
  }
  return path => names.has(resolve(path));
}

/** How many checkouts the refusal below names before it stops listing them. */
const NAMED_CHECKOUTS = 6;

/**
 * Why `directory` cannot ground a session, or null when it can.
 *
 * The one case today is a worktree CONTAINER: the folder the shared git dir lives in, with one
 * folder per branch beside it. It is not a work tree, so nothing is checked out there and no
 * branch can be; git nonetheless answers rev-parse for the bare repo, which is how a container
 * comes to look like a repository on a branch while being nowhere a session could run. Picking
 * one leaves every tool rooted beside the checkouts rather than in one of them - the same
 * confusion that makes `pnpm --filter` there resolve a different manifest than it does inside.
 *
 * Refused rather than resolved to one of the checkouts: which one is a guess, and a guess here
 * would silently run the session's commands somewhere other than the folder the user picked.
 */
export async function unusableProjectReason(directory: string): Promise<string | null> {
  const checkouts = await containerCheckouts(directory);
  if (!checkouts) return null;

  const named = checkouts.slice(0, NAMED_CHECKOUTS);
  const rest = checkouts.length - named.length;
  const inside = named.length
    ? `Pick one of the checkouts inside it instead: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`
    : 'It has no checkouts in it - create one with a worktree before pointing a session at it.';
  return `${directory} holds the repository but is not a checkout of it: it is the folder the worktrees live in, so no branch is checked out there. ${inside}`;
}

/**
 * The folder names to point at, when `directory` is a worktree container.
 *
 * Only the container's own children, sorted. git lists every worktree it has ever registered,
 * in registration order, which on a long-lived repository opens with tooling's own nested
 * checkouts (.claude/worktrees, .manifold/worktrees) - not folders anyone picks, and not what
 * this layout means by "beside the bare repo".
 */
async function containerCheckouts(directory: string): Promise<string[] | null> {
  try {
    if (await isGitRepository(directory)) return null;
    const container = resolve(await containerDirectory(directory));
    if (container !== resolve(directory)) return null;
    return (await listWorktrees(directory))
      .filter(entry => dirname(resolve(entry.path)) === container)
      .map(entry => basename(entry.path))
      .sort();
  } catch {
    // Not a repository at all, which is an ordinary folder a session is welcome to run in.
    return null;
  }
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

/**
 * Tracked files with uncommitted changes in `directory`, staged or not, as git names them.
 *
 * Untracked files are left out: a switch carries them untouched, and git itself refuses one that
 * would overwrite an untracked file, so they cannot be lost by `checkoutBranch`. Counting them
 * would refuse every checkout that has a stray build log or a local env backup lying around.
 */
export async function uncommittedChanges(directory: string): Promise<string[]> {
  const stdout = await git(directory, ['status', '--porcelain', '--untracked-files=no']);
  return stdout
    .split('\n')
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Switch `directory` onto `branch`, creating it from HEAD when `create` is set.
 *
 * Never forced and never stashed: a refusal from git (a conflicting untracked file, say) comes
 * back as its own GitError for the user to read. A branch another worktree holds is caught
 * before this is called; see ChatService.checkoutInPlace. `--no-guess`
 * keeps a name that is only on a remote from being quietly turned into a new tracking branch.
 */
export async function checkoutBranch(directory: string, branch: string, create: boolean): Promise<void> {
  await git(directory, create ? ['switch', '--quiet', '-c', branch] : ['switch', '--quiet', '--no-guess', branch]);
}
