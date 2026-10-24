import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { describe, expect, it } from 'vitest';
import { ChangesBar, CreatePullRequestButton } from './ChangesBar';

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
