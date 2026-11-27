import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { describe, expect, it } from 'vitest';
import { ChangesBar, CreatePullRequestButton } from './ChangesBar';
import { changesStateLabel, createPullRequestPrompt, filesChangedLabel } from './changesBarModel';

const CHANGES: WorkspaceChanges = {
  base: 'origin/main',
  added: 53,
  removed: 1,
  fileCount: 2,
  files: [
    { path: 'src/userPath.ts', added: 1, removed: 1 },
    { path: 'src/userPath.test.ts', added: 52, removed: 0, untracked: true },
  ],
  commitsAhead: 0,
  uncommitted: 2,
};

function markup(changes: WorkspaceChanges): string {
  return renderToStaticMarkup(<ChangesBar changes={changes} />);
}

function button(busy: boolean): string {
  return renderToStaticMarkup(<CreatePullRequestButton changes={CHANGES} busy={busy} onCreatePullRequest={() => {}} />);
}

const has = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);

describe('ChangesBar', () => {
  it('shows the file count, the totals and where they stand', () => {
    const html = markup(CHANGES);

    expect(html).toContain('2 files changed');
    expect(html).toMatch(/data-testid="changes-bar-diff"[^>]*>.*\+53.*-1/);
    expect(html).toMatch(/data-testid="changes-bar-state"[^>]*>uncommitted</);
  });

  it('leaves out the state line when everything is committed on a branch with no commits ahead', () => {
    expect(has(markup({ ...CHANGES, uncommitted: 0 }), 'changes-bar-state')).toBe(false);
  });
});

describe('CreatePullRequestButton', () => {
  it('is enabled while no reply is running', () => {
    const html = button(false);
    expect(has(html, 'changes-bar-create-pr-btn')).toBe(true);
    expect(html).not.toMatch(/data-testid="changes-bar-create-pr-btn"[^>]*Mui-disabled/);
  });

  // Joy marks a disabled button with a class in static markup, not the attribute.
  it('is disabled while a reply is running', () => {
    expect(button(true)).toMatch(/data-testid="changes-bar-create-pr-btn"[^>]*Mui-disabled/);
  });
});

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
