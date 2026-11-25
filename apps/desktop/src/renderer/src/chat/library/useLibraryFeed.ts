import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryApi } from '@shared/library';
import {
  appendPage,
  emptyFeed,
  needsFirstLoad,
  nextToLoad,
  visibleItems,
  type FeedState,
  type LibraryFilter,
} from './libraryFeed';

export function describeLibraryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error(?:: |$))?/, '') || 'Something went wrong.';
}

/**
 * The Library's pages. Loads the first page of whatever the filter covers on its own, once;
 * every page after that is an explicit `loadMore`, so nothing here fetches in a loop. A failed
 * load stops the automatic first load until `refresh`.
 */
export function useLibraryFeed(filter: LibraryFilter, accountKey: string, api: Pick<LibraryApi, 'page'>) {
  const [state, setState] = useState<FeedState>(emptyFeed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by an account change or refresh, so a page from before it is dropped.
  const generation = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    const media = nextToLoad(stateRef.current, filter);
    if (media.length === 0) return;
    const current = generation.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const pages = await Promise.all(
        media.map(async medium => {
          const cursor = stateRef.current[medium].cursor;
          return { medium, page: await api.page({ medium, ...(cursor ? { cursor } : {}) }) };
        })
      );
      if (current !== generation.current) return;
      setState(previous => pages.reduce((next, { medium, page }) => appendPage(next, medium, page), previous));
    } catch (failure) {
      if (current === generation.current) setError(describeLibraryError(failure));
    } finally {
      if (current === generation.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [api, filter]);

  const reset = useCallback(() => {
    generation.current += 1;
    loadingRef.current = false;
    setLoading(false);
    setError(null);
    setState(emptyFeed());
  }, []);

  const firstAccount = useRef(true);
  useEffect(() => {
    if (firstAccount.current) {
      firstAccount.current = false;
      return;
    }
    reset();
  }, [accountKey, reset]);

  useEffect(() => {
    if (!error && !loading && needsFirstLoad(state, filter)) void load();
  }, [state, filter, error, loading, load]);

  return {
    items: visibleItems(state, filter),
    loading,
    error,
    hasMore: nextToLoad(state, filter).length > 0,
    /** True before the first page of the current filter has answered. */
    initial: needsFirstLoad(state, filter),
    loadMore: () => void load(),
    /** Clear a failure and load again what failed. */
    retry: () => {
      setError(null);
      void load();
    },
    refresh: reset,
  };
}
