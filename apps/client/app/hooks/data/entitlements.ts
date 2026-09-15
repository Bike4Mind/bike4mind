import { api } from '@client/app/contexts/ApiContext';
import { useIsFullyAuthenticated } from '@client/app/hooks/useAccessToken';
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
  // Gate on the fully-authenticated state so this doesn't fire during the login
  // mfaPending window, where it would 401 (#804).
  const isFullyAuthenticated = useIsFullyAuthenticated();

  return useQuery({
    queryKey: ['entitlements'],
    queryFn: async () => {
      const response = await api.get<{ entitlements: string[] }>('/api/entitlements');
      return response.data.entitlements;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    enabled: enabled && isFullyAuthenticated,
  });
};

export type EntitlementSourceType = 'tag' | 'domain' | 'subscription' | 'admin-bypass' | 'developer-bypass';

export interface EntitlementSource {
  type: EntitlementSourceType;
  detail: string;
}

export interface EntitlementAccessRow {
  key: string;
  held: boolean;
  grantTag?: string;
  sources: EntitlementSource[];
}

/**
 * Admin-only "Product Access" view of another user's product entitlements -
 * every known product key, whether they hold it, and (unlike `useEntitlements`,
 * which only returns the held-key list for the CURRENT user) the source(s)
 * behind each one: tag / domain / subscription / admin- or developer-bypass.
 * The fix for phantom-access visibility (admin can't otherwise see a
 * domain-grant or subscription hold, only tags).
 */
export const useGetUserProductAccess = (userId: string) => {
  return useQuery({
    queryKey: ['admin', 'user-entitlements', userId],
    queryFn: async () => {
      const response = await api.get<{ entitlements: EntitlementAccessRow[] }>(
        `/api/admin/users/${userId}/entitlements`
      );
      return response.data;
    },
    enabled: !!userId,
  });
};
