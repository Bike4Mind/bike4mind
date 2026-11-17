import { useCallback } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  integrationHealthSearchEntries,
  readIntegrationHealthSearch,
  type IntegrationHealthSearchState,
} from '../integrationHealthSearch';

type SearchRecord = Record<string, unknown>;

/** The URL is the source of truth for the time range and the expanded integration. */
export function useIntegrationHealthSearchParams() {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const state = readIntegrationHealthSearch(search);

  const patch = useCallback(
    (next: Partial<IntegrationHealthSearchState>) => {
      void navigate({
        to: '/admin',
        replace: true,
        search: ((previous: SearchRecord) => ({
          ...previous,
          ...integrationHealthSearchEntries({ ...readIntegrationHealthSearch(previous), ...next }),
        })) as never,
      });
    },
    [navigate]
  );

  return { ...state, patch };
}
