import { describe, expect, it } from 'vitest';
import { parseStoredWorktreeDefault, startsInWorktree, worktreeDefaultSummary } from './worktreeDefault';

const REPOSITORY = { isRepository: true, branches: ['main', 'feat/x'] };

describe('the worktree-by-default preference', () => {
  it('is off until the user turns it on', () => {
    expect(parseStoredWorktreeDefault(null)).toBe(false);
    expect(parseStoredWorktreeDefault('0')).toBe(false);
    expect(parseStoredWorktreeDefault('garbage')).toBe(false);
    expect(parseStoredWorktreeDefault('1')).toBe(true);
  });

  it('says what it does in the Settings summary', () => {
    expect(worktreeDefaultSummary(false)).toBe('Off');
    expect(worktreeDefaultSummary(true)).toContain('worktree');
  });
});

describe('whether a newly bound folder starts in a worktree', () => {
  it('follows the preference for a repository with branches', () => {
    expect(startsInWorktree(true, REPOSITORY)).toBe(true);
    expect(startsInWorktree(false, REPOSITORY)).toBe(false);
  });

  /** main refuses a worktree with no base, so asking for one would turn a folder pick into an error. */
  it('stands down for a folder that cannot hold a worktree', () => {
    expect(startsInWorktree(true, { isRepository: false, branches: [] })).toBe(false);
    expect(startsInWorktree(true, { isRepository: true, branches: [] })).toBe(false);
  });
});
