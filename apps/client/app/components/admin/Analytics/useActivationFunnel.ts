import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { ActivationFunnel } from '@client/app/utils/activationFunnel';
import type { AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';

// The funnel counts signups, which always exclude internal accounts, so the Accounts toggle would refetch identical steps.
const funnelParamsOf = ({ range, from, to, compare, signups }: AnalyticsOverviewQuery) => ({
  range,
  from,
  to,
  compare,
  signups,
});

export const activationFunnelQueryKey = (query: AnalyticsOverviewQuery) =>
  ['admin', 'analytics', 'activation', funnelParamsOf(query)] as const;

/** Computed live per request, so it loads and fails separately from the rollup-backed overview. */
export function useActivationFunnel(query: AnalyticsOverviewQuery, enabled = true) {
  return useQuery({
    queryKey: activationFunnelQueryKey(query),
    queryFn: async () =>
      (await api.get<ActivationFunnel>('/api/admin/analytics/activation', { params: funnelParamsOf(query) })).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
