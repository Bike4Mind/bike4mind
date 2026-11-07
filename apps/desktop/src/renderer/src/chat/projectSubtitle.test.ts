import { describe, expect, it } from 'vitest';
import { folderName, projectSubtitle } from './projectSubtitle';

const REPO = '/Users/someone/dev/bike4mind';
const WORKTREE = `${REPO}/.b4m/worktrees/b4m+this-session-is-long-abc123`;

const project = (overrides: Partial<Parameters<typeof projectSubtitle>[0]> = {}) => ({
  directory: REPO,
  name: 'bike4mind',
  workingDirectory: REPO,
  ...overrides,
});

describe('projectSubtitle', () => {
  it('names the project and the worktree branch, and keeps the full path for the tooltip', () => {
    expect(
      projectSubtitle(project({ workspaceBranch: 'b4m/this-session-is-long-abc123', workingDirectory: WORKTREE }))
    ).toEqual({ label: 'bike4mind \u00B7 b4m/this-session-is-long-abc123', path: WORKTREE });
  });

  it('falls back to the worktree folder when no branch was recorded', () => {
    expect(projectSubtitle(project({ workingDirectory: WORKTREE })).label).toBe(
      'bike4mind \u00B7 b4m+this-session-is-long-abc123'
    );
  });

  it('shows only the project outside a worktree, including one still waiting to be cut', () => {
    expect(projectSubtitle(project())).toEqual({ label: 'bike4mind', path: REPO });
    expect(projectSubtitle(project({ workspaceBranch: 'b4m/pending' })).label).toBe('bike4mind');
  });

  it('takes the folder name when the project has no name', () => {
    expect(projectSubtitle(project({ name: '  ' })).label).toBe('bike4mind');
    expect(projectSubtitle(project({ name: '', directory: '/', workingDirectory: '/' })).label).toBe('/');
  });
});

describe('folderName', () => {
  it.each([
    ['/a/b/c', 'c'],
    ['/a/b/c/', 'c'],
    ['C:\\work\\repo', 'repo'],
    ['repo', 'repo'],
    ['/', '/'],
  ])('%s -> %s', (path, expected) => {
    expect(folderName(path)).toBe(expected);
  });
});
