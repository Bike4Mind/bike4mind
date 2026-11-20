import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AcquisitionConversion } from '@client/app/utils/acquisitionConversion';
import type { AnalyticsOverviewQuery } from '@client/app/utils/analyticsOverview';
import type { AcquisitionControls } from './analyticsTabSearch';

// Signups always exclude internal accounts, so the Accounts toggle is left out of the request and the key.
const acquisitionParamsOf = (
  { range, from, to, signups }: AnalyticsOverviewQuery,
  { touch, window, followUp }: AcquisitionControls
) => ({ range, from, to, signups, touch, window, followUp });

export const acquisitionConversionQueryKey = (query: AnalyticsOverviewQuery, controls: AcquisitionControls) =>
  ['admin', 'analytics', 'acquisition', acquisitionParamsOf(query, controls)] as const;

/** Computed live per request, like the activation funnel, so it loads and fails on its own. */
export function useAcquisitionConversion(query: AnalyticsOverviewQuery, controls: AcquisitionControls, enabled = true) {
  return useQuery({
    queryKey: acquisitionConversionQueryKey(query, controls),
    queryFn: async () =>
      (
        await api.get<AcquisitionConversion>('/api/admin/analytics/acquisition', {
          params: acquisitionParamsOf(query, controls),
        })
      ).data,
    enabled,
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}
