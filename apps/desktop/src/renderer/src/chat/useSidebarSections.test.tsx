// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarSections } from './useSidebarSections';
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeSidebarWidth,
} from './sidebarWidth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSidebarSections', () => {
  const initial: SidebarSectionsState = { sections: [{ id: 'a', name: 'Work' }], assignments: {} };
  const renamed: SidebarSectionsState = { sections: [{ id: 'a', name: 'Day job' }], assignments: {} };

  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let latest: ReturnType<typeof useSidebarSections> | null = null;

  function Probe() {
    latest = useSidebarSections();
    return null;
  }

  async function mount(renameSection: (id: string, name: string) => Promise<SidebarSectionsState>) {
    (window as unknown as { b4m: unknown }).b4m = {
      sidebar: { getSections: () => Promise.resolve(initial), renameSection },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Probe />));
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    latest = null;
    vi.restoreAllMocks();
  });

  describe('useSidebarSections', () => {
    it('applies the state main answers with', async () => {
      await mount(() => Promise.resolve(renamed));
      expect(latest?.sections).toEqual(initial);

      await act(async () => latest?.actions.rename('a', 'Day job'));

      expect(latest?.sections).toEqual(renamed);
    });

    it('keeps the previous state when the call rejects', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await mount(() => Promise.reject(new Error('disk full')));

      await act(async () => latest?.actions.rename('a', 'Day job'));

      expect(latest?.sections).toEqual(initial);
      expect(error).toHaveBeenCalled();
    });

    it('reports a failed write until it is dismissed or a later one succeeds', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const renameSection = vi
        .fn<(id: string, name: string) => Promise<SidebarSectionsState>>()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValueOnce(renamed);
      await mount(renameSection);
      expect(latest?.error).toBeNull();

      await act(async () => latest?.actions.rename('a', 'Day job'));
      expect(latest?.error).toBe('Could not save that section change.');

      act(() => latest?.dismissError());
      expect(latest?.error).toBeNull();

      await act(async () => latest?.actions.rename('a', 'Day job'));
      expect(latest?.error).not.toBeNull();

      await act(async () => latest?.actions.rename('a', 'Day job'));
      expect(latest?.error).toBeNull();
      expect(latest?.sections).toEqual(renamed);
    });

    it('clears a previous failure when main hands back the state for a new session', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await mount(() => Promise.reject(new Error('disk full')));

      await act(async () => latest?.actions.rename('a', 'Day job'));
      expect(latest?.error).not.toBeNull();

      act(() => latest?.adopt(renamed));

      expect(latest?.sections).toEqual(renamed);
      expect(latest?.error).toBeNull();
    });

    it('reports a placement main could not save', async () => {
      await mount(() => Promise.resolve(renamed));

      act(() => latest?.placementFailed());

      expect(latest?.error).toBe('Could not put the new session in its section.');
    });
  });
});

describe('sidebarWidth', () => {
  afterEach(() => window.localStorage.clear());

  describe('clampSidebarWidth', () => {
    it('holds the drag inside the bounds', () => {
      expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 120)).toBe(SIDEBAR_MIN_WIDTH);
      expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 400)).toBe(SIDEBAR_MAX_WIDTH);
      expect(clampSidebarWidth(320)).toBe(320);
    });

    it('rounds, because a drag reports fractional pixels on a scaled display', () => {
      expect(clampSidebarWidth(317.6)).toBe(318);
    });

    it('falls back rather than letting NaN out to a width', () => {
      expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    });
  });

  describe('readSidebarWidth', () => {
    it('is the default until something has been stored', () => {
      expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it('round-trips a width the user dragged to', () => {
      writeSidebarWidth(344);
      expect(readSidebarWidth()).toBe(344);
    });

    // The bounds can move between releases; a width stored under the old ones cannot.
    it('clamps on the way out as well as in', () => {
      window.localStorage.setItem('b4m.sidebar.width', '4000');
      expect(readSidebarWidth()).toBe(SIDEBAR_MAX_WIDTH);
    });

    it('ignores a value that is not a width at all', () => {
      window.localStorage.setItem('b4m.sidebar.width', 'wide');
      expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
    });
  });
});
