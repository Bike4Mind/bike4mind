import { useEffect, useState } from 'react';
import type { ChatSessionSummary } from '@shared/chat';

/** Typing pause before the host is asked, so a word typed fast is one search, not one per key. */
export const SESSION_SEARCH_DEBOUNCE_MS = 150;

export type SessionSearchFn = (query: string) => Promise<{ sessions: ChatSessionSummary[]; total: number }>;

export interface SessionSearchResult {
  /** Matches across the whole list, including sessions no page has loaded yet. */
  sessions: ChatSessionSummary[];
  /** Matches in all; more than `sessions.length` when the host capped the reply. */
  total: number;
}

const NONE: SessionSearchResult = { sessions: [], total: 0 };

/**
 * Title matches for `query` from the host, so a search finds sessions past the loaded pages.
 * Debounced, and a reply for a query the user has since changed is dropped. Without `search`
 * (a caller that holds the whole list) it returns nothing and the local filter is the search.
 */
export function useSessionSearch(query: string, search: SessionSearchFn | undefined): SessionSearchResult {
  const [result, setResult] = useState<{ query: string; value: SessionSearchResult }>({ query: '', value: NONE });
  const needle = query.trim();

  useEffect(() => {
    if (!search || needle === '') return;
    let current = true;
    const timer = setTimeout(() => {
      search(needle).then(
        value => current && setResult({ query: needle, value }),
        (err: unknown) => console.warn('Session search failed', err)
      );
    }, SESSION_SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [needle, search]);

  return result.query === needle && needle !== '' ? result.value : NONE;
}
