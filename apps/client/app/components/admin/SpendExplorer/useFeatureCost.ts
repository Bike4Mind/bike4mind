import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SpendAudience, SpendFeaturesResponse, SpendFeatureUsersResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { SpendRange } from './spendExplorerModel';

// Matches the server's 5-minute cache: refetching sooner would only read the same entry.
const STALE_MS = 5 * 60 * 1000;

const rangeParams = (range: SpendRange, audience: SpendAudience) =>
  new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), audience });

/** Per-feature cost for the range; `userId` narrows it to the calls one user ran. */
export function useSpendFeatures(params: {
  range: SpendRange;
  audience: SpendAudience;
  userId?: string;
  enabled?: boolean;
}) {
  const query = rangeParams(params.range, params.audience);
  if (params.userId) query.set('userId', params.userId);
  const queryString = query.toString();
  return useQuery({
    queryKey: ['admin-spend-explorer', 'features', queryString],
    queryFn: async () =>
      (await api.get<SpendFeaturesResponse>(`/api/admin/spend-explorer/features?${queryString}`)).data,
    enabled: params.enabled ?? true,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}

/** One page of a feature's users; `page` is 1-based. */
export function useSpendFeatureUsers(params: {
  range: SpendRange;
  audience: SpendAudience;
  feature: string;
  page: number;
  pageSize: number;
}) {
  const query = rangeParams(params.range, params.audience);
  query.set('feature', params.feature);
  query.set('limit', String(params.pageSize));
  query.set('offset', String((params.page - 1) * params.pageSize));
  const queryString = query.toString();
  return useQuery({
    queryKey: ['admin-spend-explorer', 'feature-users', queryString],
    queryFn: async () =>
      (await api.get<SpendFeatureUsersResponse>(`/api/admin/spend-explorer/feature-users?${queryString}`)).data,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}
