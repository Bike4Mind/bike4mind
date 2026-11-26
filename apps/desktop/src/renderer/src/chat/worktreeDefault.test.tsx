// @vitest-environment jsdom
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';
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
import type { AppWorktree, WorktreeSweepItem } from '@shared/worktreeRemoval';
import { useWorktrees, type WorktreesState } from './useWorktrees';
import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreesView } from './WorktreesSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('worktreeDefault', () => {
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
});

describe('useWorktrees', () => {
  const directory = '/repo';
  const path = '/repo/.b4m/worktrees/orphan';
  const worktree: AppWorktree = {
    path,
    branch: 'b4m/orphan',
    safe: true,
    reason: null,
    state: 'clean',
    owner: null,
    lastCommit: null,
  };
  const removed: WorktreeSweepItem[] = [{ path, branch: worktree.branch, status: 'removed', message: null }];
  const listWorktrees = vi.fn<(directory: string) => Promise<AppWorktree[]>>();
  const removeWorktrees = vi.fn<(directory: string, paths?: string[]) => Promise<WorktreeSweepItem[]>>();
  const revealWorktree = vi.fn<(directory: string, path: string) => Promise<boolean>>();

  function Probe() {
    const state = useWorktrees();
    return (
      <>
        <button data-testid="remove" disabled={state.busy} onClick={() => void state.removeOne(directory, path)}>
          Remove
        </button>
        <button data-testid="sweep" onClick={() => void state.removeAllSafe(directory)}>
          Sweep
        </button>
        <button data-testid="reveal" onClick={() => void state.reveal(directory, path)}>
          Reveal
        </button>
        <output data-testid="projects">{JSON.stringify(state.projects)}</output>
        <output data-testid="report">{JSON.stringify(state.report)}</output>
        <output data-testid="loading">{String(state.loading)}</output>
      </>
    );
  }

  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    listWorktrees.mockReset();
    removeWorktrees.mockReset();
    revealWorktree.mockReset();
    listWorktrees.mockResolvedValue([worktree]);
    removeWorktrees.mockResolvedValue(removed);
    revealWorktree.mockResolvedValue(true);
    vi.stubGlobal('b4m', {
      host: chatBackedHostBridge(),
      chat: {
        listRecentFolders: async () => [{ path: directory, name: 'repo' }],
        listWorktrees,
        removeWorktrees,
        revealWorktree,
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mount() {
    await act(async () => root.render(<Probe />));
  }

  function element(testId: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!found) throw new Error(`Missing ${testId}`);
    return found;
  }

  async function click(testId: string) {
    await act(async () => element(testId).click());
  }

  describe('useWorktrees', () => {
    it('lists recent projects and removes exactly the selected checkout, then refreshes the rows', async () => {
      await mount();
      expect(listWorktrees).toHaveBeenCalledWith(directory);
      expect(element('loading').textContent).toBe('false');
      expect(element('projects').textContent).toContain(path);
      listWorktrees.mockResolvedValue([]);

      await click('remove');

      expect(removeWorktrees).toHaveBeenCalledExactlyOnceWith(directory, [path]);
      expect(listWorktrees).toHaveBeenCalledTimes(2);
      expect(element('projects').textContent).toBe('[]');
      expect(element('report').textContent).toBe(JSON.stringify(removed));
    });

    it('omits the path argument for a project-wide sweep and refreshes afterward', async () => {
      await mount();
      await click('sweep');
      expect(removeWorktrees).toHaveBeenCalledExactlyOnceWith(directory);
      expect(listWorktrees).toHaveBeenCalledTimes(2);
    });

    it('reports a rejected removal and still refreshes and enables removal again', async () => {
      await mount();
      removeWorktrees.mockRejectedValue(new Error('Could not verify ownership'));
      await click('remove');
      expect(element('report').textContent).toContain('Could not verify ownership');
      expect(element('report').textContent).toContain('"status":"failed"');
      expect(listWorktrees).toHaveBeenCalledTimes(2);
      expect(element('remove').hasAttribute('disabled')).toBe(false);
    });

    it('reports a stale reveal and removes the stale row by refreshing the list', async () => {
      await mount();
      revealWorktree.mockResolvedValue(false);
      listWorktrees.mockResolvedValue([]);
      await click('reveal');
      expect(revealWorktree).toHaveBeenCalledExactlyOnceWith(directory, path);
      expect(element('report').textContent).toContain('This worktree is no longer listed.');
      expect(element('report').textContent).toContain('"status":"skipped"');
      expect(element('projects').textContent).toBe('[]');
      expect(listWorktrees).toHaveBeenCalledTimes(2);
    });

    it('reports reveal failures without losing the current rows', async () => {
      await mount();
      revealWorktree.mockRejectedValue(new Error('File manager unavailable'));
      await click('reveal');
      expect(element('report').textContent).toContain('File manager unavailable');
      expect(element('report').textContent).toContain('"status":"failed"');
      expect(element('projects').textContent).toContain(path);
    });

    it('surfaces a project listing failure instead of claiming there are no worktrees', async () => {
      listWorktrees.mockRejectedValue(new Error('Cannot read conversations'));
      await mount();
      expect(element('projects').textContent).toContain('Cannot read conversations');
      expect(element('loading').textContent).toBe('false');
    });
  });
});

describe('WorktreesSettings', () => {
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
});
