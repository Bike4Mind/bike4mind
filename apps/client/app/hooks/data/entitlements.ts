import { api } from '@client/app/contexts/ApiContext';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

/**
 * The authenticated user's entitlement keys (subscription- and tag-derived,
 * resolved server-side - see `@server/entitlements`).
 *
 * Freshness model: the Stripe webhook / admin-grant handlers push
 * `invalidate_query ['entitlements']` over the websocket as a latency
 * optimization; the `staleTime` + window-focus refetch below is the
 * correctness backstop when that push is missed (socket down, no replay on
 * reconnect). `keepPreviousData` keeps gates from flashing null on background
 * refetches between gated routes.
 *
 * Cache scoping: logout clears the query cache (`clearClientCaches()` +
 * `queryClient.removeQueries()` in login.tsx), so the unscoped key is safe;
 * the IDB-rehydration race there is pre-existing and shared with
 * `['subscriptions']`.
 */
export const useEntitlements = (options: { enabled?: boolean } = {}) => {
  const { enabled = true } = options;

  return useQuery({
    queryKey: ['entitlements'],
    queryFn: async () => {
      const response = await api.get<{ entitlements: string[] }>('/api/entitlements');
      return response.data.entitlements;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    enabled,
  });
};
