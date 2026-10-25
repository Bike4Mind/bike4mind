import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { describe, expect, it } from 'vitest';
import { changesStateLabel, createPullRequestPrompt, filesChangedLabel } from './changesBarModel';

function changes(over: Partial<WorkspaceChanges> = {}): WorkspaceChanges {
  return {
    base: 'origin/main',
    added: 53,
    removed: 1,
    fileCount: 2,
    files: [],
    commitsAhead: 0,
    uncommitted: 2,
    ...over,
  };
}

describe('filesChangedLabel', () => {
  it('counts files, singular for one', () => {
    expect(filesChangedLabel(changes())).toBe('2 files changed');
    expect(filesChangedLabel(changes({ fileCount: 1 }))).toBe('1 file changed');
  });
});

describe('changesStateLabel', () => {
  it('says what a commit would still pick up, and what the branch already holds', () => {
    expect(changesStateLabel(changes())).toBe('uncommitted');
    expect(changesStateLabel(changes({ commitsAhead: 1 }))).toBe('1 commit + uncommitted');
    expect(changesStateLabel(changes({ commitsAhead: 3, uncommitted: 0 }))).toBe('3 commits');
  });
});

describe('createPullRequestPrompt', () => {
  it('asks for a commit first only when there is something uncommitted', () => {
    expect(createPullRequestPrompt(changes())).toMatch(/^Commit the uncommitted changes/);
    expect(createPullRequestPrompt(changes({ uncommitted: 0, commitsAhead: 2 }))).toMatch(/^Push this branch/);
  });

  it('names the base without the remote prefix, and asks for gh pr create so the PR bar binds', () => {
    const prompt = createPullRequestPrompt(changes({ base: 'origin/release' }));
    expect(prompt).toContain('against `release`');
    expect(prompt).toContain('gh pr create');
  });
});
