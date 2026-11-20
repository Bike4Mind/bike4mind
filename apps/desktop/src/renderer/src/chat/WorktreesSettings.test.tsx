import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppWorktree } from '@shared/worktreeRemoval';
import { WorktreesView } from './WorktreesSettings';
import type { WorktreesState } from './useWorktrees';

const markup = (node: React.ReactNode) => renderToStaticMarkup(<CssVarsProvider>{node}</CssVarsProvider>);

const worktree = (over: Partial<AppWorktree>): AppWorktree => ({
  path: '/repo/.b4m/worktrees/a',
  branch: 'app/a',
  safe: true,
  reason: null,
  state: 'clean',
  owner: null,
  lastCommit: '2026-10-01',
  ...over,
});

const stateOf = (over: Partial<WorktreesState>): WorktreesState => ({
  projects: [],
  loading: false,
  busy: false,
  report: [],
  removeOne: vi.fn(),
  removeAllSafe: vi.fn(),
  reveal: vi.fn(),
  ...over,
});

const render = (over: Partial<WorktreesState>) => markup(<WorktreesView state={stateOf(over)} />);

describe('the Worktrees view', () => {
  const mixed = render({
    projects: [
      {
        directory: '/repo',
        name: 'repo',
        error: null,
        worktrees: [
          worktree({}),
          worktree({
            path: '/repo/.b4m/worktrees/b',
            branch: 'app/b',
            safe: false,
            state: 'dirty',
            reason: 'Has uncommitted changes',
          }),
          worktree({
            path: '/repo/.b4m/worktrees/c',
            branch: 'app/c',
            safe: false,
            state: 'owned',
            owner: 'Fix login',
          }),
        ],
      },
    ],
  });
  const rowFor = (branch: string) =>
    mixed.split('data-testid="worktrees-row"').find(part => part.includes(`>${branch}<`)) ?? '';

  it('offers Remove on a safe orphan and a project-wide sweep', () => {
    expect(mixed).toContain('data-testid="worktrees-remove-all-btn"');
    expect(mixed.match(/data-testid="worktrees-remove-btn"/g)).toHaveLength(1);
    expect(mixed).toContain('Remove all safe (1)');
  });

  it('shows the reason and Reveal, and no Remove, on an unsafe orphan', () => {
    const row = rowFor('app/b');
    expect(row).toContain('Has uncommitted changes');
    expect(row).toContain('worktrees-reveal-btn');
    expect(row).toContain('Show in folder');
    expect(row).not.toContain('worktrees-remove-btn');
  });

  it('gives a worktree a conversation uses neither action', () => {
    const row = rowFor('app/c');
    expect(row).toContain('Used by Fix login');
    expect(row).not.toContain('worktrees-remove-btn');
    expect(row).not.toContain('worktrees-reveal-btn');
  });

  it('says so when there is nothing to clean up', () => {
    expect(render({})).toContain('data-testid="worktrees-empty-label"');
  });

  it('summarises a sweep that skipped and failed some paths', () => {
    const html = render({
      report: [
        { path: '/p/a', branch: 'app/a', status: 'removed', message: null },
        { path: '/p/b', branch: 'app/b', status: 'skipped', message: 'Has uncommitted changes' },
        { path: '/p/c', branch: 'app/c', status: 'failed', message: 'branch not fully merged' },
      ],
    });
    expect(html).toContain('Removed 1, skipped 1, failed 1.');
    expect(html).toContain('data-testid="worktrees-report-skipped-item"');
    expect(html).toContain('data-testid="worktrees-report-failed-item"');
    expect(html).toContain('branch not fully merged');
  });

  it('shows a project whose worktrees could not be read', () => {
    const html = render({ projects: [{ directory: '/repo', name: 'repo', worktrees: [], error: 'boom' }] });
    expect(html).toContain('Could not read worktrees. boom');
  });
});
