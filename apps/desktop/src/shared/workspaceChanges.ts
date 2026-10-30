/** One file that differs from the session's base, as `git diff --numstat` counts it. */
export interface ChangedFile {
  /** Relative to the working directory, as git names it. */
  path: string;
  added: number;
  removed: number;
  /** git counts no lines for a binary file, so `added`/`removed` are 0 rather than unknown. */
  binary?: true;
  /** Not yet known to git; its lines are counted from disk. */
  untracked?: true;
}

/**
 * What a Code session's working directory holds that its base branch does not: committed on the
 * session's branch, staged, unstaged and untracked alike - everything a pull request from here
 * would carry once committed.
 *
 * Read from git rather than summed from the transcript's tool diffs, because the transcript misses
 * every change made through a shell command and keeps counting edits that were since reverted or
 * committed elsewhere. See main/chat/project/workspaceChanges.ts.
 */
export interface WorkspaceChanges {
  /** The ref the diff is measured from, e.g. `origin/main`. */
  base: string;
  added: number;
  removed: number;
  /** Total files changed, which can exceed `files.length` when the list is capped. */
  fileCount: number;
  files: ChangedFile[];
  /** Commits on HEAD that the base does not have. */
  commitsAhead: number;
  /** Paths `git status` reports as changed or untracked, i.e. what a commit would still pick up. */
  uncommitted: number;
}
