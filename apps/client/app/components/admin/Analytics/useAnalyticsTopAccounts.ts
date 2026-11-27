import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AnalyticsOverviewQuery, AnalyticsTopAccounts } from '@client/app/utils/analyticsOverview';

// Only the range shapes the tables: compare and signups would refetch identical rows.
const rangeOf = ({ range, from, to }: AnalyticsOverviewQuery) => ({ range, from, to });

export const analyticsTopAccountsQueryKey = (query: AnalyticsOverviewQuery) =>
  ['admin', 'analytics', 'top-accounts', rangeOf(query)] as const;

/** Reads complete rollup days only, so the same 5 minute staleTime as the overview. */
export function useAnalyticsTopAccounts(query: AnalyticsOverviewQuery, enabled = true) {
  return useQuery({
    queryKey: analyticsTopAccountsQueryKey(query),
    queryFn: async () =>
      (await api.get<AnalyticsTopAccounts>('/api/admin/analytics/top-accounts', { params: rangeOf(query) })).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
