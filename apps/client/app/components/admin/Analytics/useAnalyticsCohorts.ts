import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import {
  COHORT_DEFAULT_WEEKS,
  type AnalyticsCohorts,
  type AnalyticsCohortsQuery,
} from '@client/app/utils/analyticsCohorts';

export const analyticsCohortsQueryKey = (query: AnalyticsCohortsQuery) =>
  ['admin', 'analytics', 'cohorts', query] as const;

/** Rollup-backed and read through the last complete day, so a 5 minute staleTime hides nothing. */
export function useAnalyticsCohorts(signups: AnalyticsCohortsQuery['signups'], weeks = COHORT_DEFAULT_WEEKS) {
  const query: AnalyticsCohortsQuery = { weeks, signups };
  return useQuery({
    queryKey: analyticsCohortsQueryKey(query),
    queryFn: async () => (await api.get<AnalyticsCohorts>('/api/admin/analytics/cohorts', { params: query })).data,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
