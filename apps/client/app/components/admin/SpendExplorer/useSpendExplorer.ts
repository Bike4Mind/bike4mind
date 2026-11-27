import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { SpendAccountsResponse, SpendSplitDimension, SpendTimelineResponse } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { SpendRange } from './spendExplorerModel';

// Matches the server's 5-minute cache: refetching sooner would only read the same entry.
const STALE_MS = 5 * 60 * 1000;

/** `userId` narrows the timeline to the calls one user ran, whoever paid for them. */
export function useSpendTimeline(params: { range: SpendRange; splitBy: SpendSplitDimension; userId?: string }) {
  const { range, splitBy, userId } = params;
  const query = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), splitBy });
  if (userId) query.set('userId', userId);
  const queryString = query.toString();
  return useQuery({
    queryKey: ['admin-spend-explorer', 'timeline', queryString],
    queryFn: async () =>
      (await api.get<SpendTimelineResponse>(`/api/admin/spend-explorer/timeline?${queryString}`)).data,
    staleTime: STALE_MS,
    // Keep the old chart up while a new split or range loads, instead of flashing a skeleton.
    placeholderData: keepPreviousData,
  });
}

export function useSpendAccounts(params: { range: SpendRange; compare?: SpendRange; limit?: number }) {
  const { range, compare, limit = 20 } = params;
  const query = new URLSearchParams({
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    limit: String(limit),
  });
  if (compare) {
    query.set('compareFrom', compare.from.toISOString());
    query.set('compareTo', compare.to.toISOString());
  }
  const queryString = query.toString();
  return useQuery({
    queryKey: ['admin-spend-explorer', 'accounts', queryString],
    queryFn: async () =>
      (await api.get<SpendAccountsResponse>(`/api/admin/spend-explorer/accounts?${queryString}`)).data,
    staleTime: STALE_MS,
    placeholderData: keepPreviousData,
  });
}
