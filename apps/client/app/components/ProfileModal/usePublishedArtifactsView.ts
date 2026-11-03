import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PublishedArtifactsView = 'list' | 'grid';

interface PublishedArtifactsViewState {
  view: PublishedArtifactsView;
  setView: (view: PublishedArtifactsView) => void;
}

/** localStorage key. Exported so tests assert against the real one. */
export const PUBLISHED_ARTIFACTS_VIEW_KEY = 'published-artifacts-view';

/**
 * Whether the Live Artifacts tab shows rows or cards, remembered across visits. Only a stored
 * 'grid' is honoured; anything else (a hand-edited or stale value) falls back to the list, which is
 * what the tab looked like before this preference existed.
 */
export const usePublishedArtifactsView = create<PublishedArtifactsViewState>()(
  persist(
    set => ({
      view: 'list',
      setView: view => set({ view }),
    }),
    {
      name: PUBLISHED_ARTIFACTS_VIEW_KEY,
      partialize: state => ({ view: state.view }),
      merge: (persisted, current) => ({
        ...current,
        view: (persisted as { view?: unknown } | null)?.view === 'grid' ? 'grid' : 'list',
      }),
    }
  )
);
