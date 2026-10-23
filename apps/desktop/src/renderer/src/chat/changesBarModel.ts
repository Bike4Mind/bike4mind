import type { WorkspaceChanges } from '@shared/workspaceChanges';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "3 files changed". */
export function filesChangedLabel(changes: WorkspaceChanges): string {
  return `${plural(changes.fileCount, 'file')} changed`;
}

/**
 * Where the changes stand, beside the count: whether a commit is still needed, and how many the
 * branch already holds. Says nothing about the remote - this bar never asks it, so "not pushed"
 * would be a guess.
 */
export function changesStateLabel(changes: WorkspaceChanges): string {
  const commits = changes.commitsAhead > 0 ? plural(changes.commitsAhead, 'commit') : null;
  if (changes.uncommitted > 0) return commits ? `${commits} + uncommitted` : 'uncommitted';
  return commits ?? '';
}

/**
 * What the Create PR button sends as the user's next message.
 *
 * The agent does the work - it already has git and gh, and the session's approval mode still
 * gates the push - so this only says what to do, not how. It names the base so the PR is opened
 * against what the bar measured from, and asks for the URL back because `gh pr create` printing
 * it is what binds the PR bar (PrMonitor.observeToolEnd).
 */
export function createPullRequestPrompt(changes: WorkspaceChanges): string {
  const base = changes.base.replace(/^origin\//, '');
  const commit =
    changes.uncommitted > 0 ? 'Commit the uncommitted changes in this working directory, then push' : 'Push';
  return (
    `${commit} this branch and open a pull request against \`${base}\` with \`gh pr create\`. ` +
    `If the checked-out branch is \`${base}\` itself, create a new branch for the changes first. ` +
    "Follow this repository's conventions for the branch name, the commit message, the PR title and the PR template " +
    'if it has them. Reply with the PR URL.'
  );
}
