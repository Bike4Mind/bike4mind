import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { rateLimitsSearchEntries, readRateLimitsSearch, type RateLimitsSearchState } from '../rateLimitsSearch';

type SearchRecord = Record<string, unknown>;

/** The URL is the source of truth for the applied filters and the sub-tab. */
export function useRateLimitsSearchParams() {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const state = readRateLimitsSearch(search);

  const patch = useCallback(
    (next: Partial<RateLimitsSearchState>) => {
      void navigate({
        to: '/admin',
        replace: true,
        search: ((previous: SearchRecord) => ({
          ...previous,
          ...rateLimitsSearchEntries({ ...readRateLimitsSearch(previous), ...next }),
        })) as never,
      });
    },
    [navigate]
  );

  return { ...state, patch };
}
