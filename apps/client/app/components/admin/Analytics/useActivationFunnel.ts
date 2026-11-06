import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { ActivationFunnel } from '@client/app/utils/activationFunnel';
import type { AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';

export const activationFunnelQueryKey = (query: AnalyticsOverviewQuery) =>
  ['admin', 'analytics', 'activation', query] as const;

/** Computed live per request, so it loads and fails separately from the rollup-backed overview. */
export function useActivationFunnel(query: AnalyticsOverviewQuery, enabled = true) {
  return useQuery({
    queryKey: activationFunnelQueryKey(query),
    queryFn: async () => (await api.get<ActivationFunnel>('/api/admin/analytics/activation', { params: query })).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
