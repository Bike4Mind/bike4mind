// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canHoldWorktree,
  parseStoredWorktreeDefault,
  setWorktreeByDefault,
  useWorktreeByDefault,
  worktreeByDefault,
  worktreeDefaultSummary,
} from './worktreeDefault';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = 'b4m.code.worktreeByDefault';

const REPOSITORY = { isRepository: true, branches: ['main', 'feat/x'], currentBranch: 'main' };

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

describe('whether a folder can hold a worktree', () => {
  it('accepts a repository with a branch to base the worktree on', () => {
    expect(canHoldWorktree(REPOSITORY)).toBe(true);
    // main bases on the checked-out branch when neither main nor master exists.
    expect(canHoldWorktree({ isRepository: true, branches: ['misc'], currentBranch: 'misc' })).toBe(true);
  });

  /** main refuses a worktree with no base, so asking for one would turn a folder pick into an error. */
  it('stands down for a folder that cannot hold a worktree', () => {
    expect(canHoldWorktree({ isRepository: false, branches: [], currentBranch: null })).toBe(false);
    expect(canHoldWorktree({ isRepository: true, branches: [], currentBranch: null })).toBe(false);
  });

  it('stands down for a detached checkout with no main or master to base on', () => {
    expect(canHoldWorktree({ isRepository: true, branches: ['develop'], currentBranch: null })).toBe(false);
  });
});

describe('the stored preference', () => {
  beforeEach(() => {
    setWorktreeByDefault(false);
    window.localStorage.clear();
  });

  afterEach(() => {
    setWorktreeByDefault(false);
    vi.restoreAllMocks();
  });

  it('persists what the user chose and reads it back on the next launch', async () => {
    setWorktreeByDefault(true);

    expect(worktreeByDefault()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');

    vi.resetModules();
    const nextLaunch = await import('./worktreeDefault');
    expect(nextLaunch.worktreeByDefault()).toBe(true);
  });

  it('keeps the value for this run when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => setWorktreeByDefault(true)).not.toThrow();
    expect(worktreeByDefault()).toBe(true);
  });

  it('starts off when storage refuses the read', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    vi.resetModules();
    const freshLaunch = await import('./worktreeDefault');
    expect(freshLaunch.worktreeByDefault()).toBe(false);
  });
});

describe('the Settings switch', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setWorktreeByDefault(false);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setWorktreeByDefault(false);
  });

  it('re-renders every reader, and the toggle flips and stores the value', async () => {
    let seen: [boolean, () => void] = [false, () => undefined];
    let renders = 0;
    function Reader() {
      seen = useWorktreeByDefault();
      renders += 1;
      return null;
    }

    await act(async () => root.render(<Reader />));
    expect(seen[0]).toBe(false);

    await act(async () => seen[1]());
    expect(seen[0]).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('1');

    const settled = renders;
    await act(async () => setWorktreeByDefault(true));
    expect(renders).toBe(settled);

    await act(async () => seen[1]());
    expect(seen[0]).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('0');
  });
});
