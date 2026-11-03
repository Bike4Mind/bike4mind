import { useEffect, useState } from 'react';
import type { ChatSessionSummary } from '@shared/chat';
import type { LocalHistoryResult } from '@shared/history';

export const LOCAL_HISTORY_CHANGED = 'local-history-changed';

type SearchState = {
  query: string;
  sessions: readonly ChatSessionSummary[];
  results: LocalHistoryResult[];
  error: string | null;
};

export function useLocalHistory(query: string, sessions: readonly ChatSessionSummary[]) {
  const needle = query.trim();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SearchState | null>(null);
  useEffect(() => {
    const invalidate = () => {
      setState(null);
      setRevision(current => current + 1);
    };
    window.addEventListener(LOCAL_HISTORY_CHANGED, invalidate);
    const unsubscribe = window.b4m?.chat?.onHistoryChanged?.(invalidate);
    return () => {
      window.removeEventListener(LOCAL_HISTORY_CHANGED, invalidate);
      unsubscribe?.();
    };
  }, []);
  useEffect(() => {
    if (!needle) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const search = async () => {
        try {
          const results = await window.b4m.chat.searchHistory(needle);
          if (!cancelled) setState({ query: needle, sessions, results, error: null });
        } catch (error) {
          if (!cancelled) {
            setState({
              query: needle,
              sessions,
              results: [],
              error: `Could not search local history. ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      };
      void search();
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [needle, sessions, revision]);
  return needle && state?.query === needle && state.sessions === sessions
    ? { results: state.results, error: state.error }
    : { results: [], error: null };
}
