import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AnalyticsOverview, AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';

export const analyticsOverviewQueryKey = (query: AnalyticsOverviewQuery) =>
  ['admin', 'analytics', 'overview', query] as const;

/** Rollup-backed, so a 5 minute staleTime only delays today's live slice. */
export function useAnalyticsOverview(query: AnalyticsOverviewQuery, enabled = true) {
  return useQuery({
    queryKey: analyticsOverviewQueryKey(query),
    queryFn: async () => (await api.get<AnalyticsOverview>('/api/admin/analytics/overview', { params: query })).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
