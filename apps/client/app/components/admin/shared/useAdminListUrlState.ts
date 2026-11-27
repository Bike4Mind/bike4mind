import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { z } from 'zod';

export type AdminListState = { query: string; filters: Record<string, string>; view: string };
export type AdminListSearchKeys = { query: string; view: string; filters: Record<string, string> };
const searchValue = (value: unknown) => z.string().max(500).catch('').parse(value);

// ms of typing idle before a search term is written to the URL.
export const SEARCH_TERM_URL_DEBOUNCE_MS = 250;

export function readAdminListState(search: Record<string, unknown>, keys: AdminListSearchKeys): AdminListState {
  return {
    query: searchValue(search[keys.query]),
    view: searchValue(search[keys.view]),
    filters: Object.fromEntries(Object.entries(keys.filters).map(([name, key]) => [name, searchValue(search[key])])),
  };
}

// A search-box edit: only the query changes (FilterBar also clears the view alongside it).
const isQueryEdit = (patch: Partial<AdminListState>) =>
  patch.query !== undefined && Object.keys(patch).every(key => key === 'query' || key === 'view');

/**
 * Register these keys in adminTabParams.ts; only persist searches that contain no personal data.
 * The query keeps local state (a router-bound input lags a navigation behind each keystroke, see
 * useAdminSettingsSearchParams.ts) and reaches the URL once typing pauses; every other patch is
 * written at once, carrying any pending query with it.
 */
export function useAdminListUrlState(
  keys: AdminListSearchKeys
): readonly [AdminListState, (patch: Partial<AdminListState>) => void] {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const urlState = readAdminListState(search, keys);
  const [query, setQuery] = useState(() => urlState.query);
  // The last query this hook pushed to the URL, so its own echo does not re-seed the box.
  const writtenQueryRef = useRef(urlState.query);
  const pendingPatchRef = useRef<Partial<AdminListState>>({});
  const pendingWriteRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Follow a query that changed from outside (back/forward, a deep link from another surface).
  useEffect(() => {
    if (urlState.query === writtenQueryRef.current) return;
    clearTimeout(pendingWriteRef.current);
    pendingPatchRef.current = {};
    writtenQueryRef.current = urlState.query;
    setQuery(urlState.query);
  }, [urlState.query]);

  useEffect(() => () => clearTimeout(pendingWriteRef.current), []);

  const flush = useCallback(() => {
    clearTimeout(pendingWriteRef.current);
    const patch = pendingPatchRef.current;
    pendingPatchRef.current = {};
    void navigate({
      to: '/admin',
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const next = { ...readAdminListState(previous, keys), ...patch };
        return {
          ...previous,
          [keys.query]: next.query || undefined,
          [keys.view]: next.view || undefined,
          ...Object.fromEntries(
            Object.entries(keys.filters).map(([name, key]) => [key, next.filters[name] || undefined])
          ),
        };
      },
    });
  }, [navigate, keys]);

  const update = useCallback(
    (patch: Partial<AdminListState>) => {
      pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
      if (patch.query !== undefined) {
        writtenQueryRef.current = patch.query;
        setQuery(patch.query);
      }
      if (!isQueryEdit(patch)) {
        flush();
        return;
      }
      clearTimeout(pendingWriteRef.current);
      pendingWriteRef.current = setTimeout(flush, SEARCH_TERM_URL_DEBOUNCE_MS);
    },
    [flush]
  );

  return [{ ...urlState, query }, update];
}
