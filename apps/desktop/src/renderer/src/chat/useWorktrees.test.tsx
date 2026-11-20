// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWorktree, WorktreeSweepItem } from '@shared/worktreeRemoval';
import { useWorktrees } from './useWorktrees';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
