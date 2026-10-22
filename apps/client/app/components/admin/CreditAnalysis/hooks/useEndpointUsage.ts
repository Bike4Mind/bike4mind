import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { ApiKeyCompletionSource, IPlatformEndpointUsageResponse } from '@bike4mind/common';

/**
 * Endpoint traffic for the admin API Usage view. Keyed independently of
 * usePlatformUsage so the panel and the credit sections never refetch each other.
 * Admin-only; the server 403s anyone else.
 */
export const useEndpointUsage = (source?: ApiKeyCompletionSource) => {
  return useQuery({
    queryKey: ['platform-usage-endpoints', source ?? null],
    queryFn: async () => {
      const { data } = await api.get<IPlatformEndpointUsageResponse>('/api/admin/platform-usage/endpoints', {
        params: { source },
      });
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
};
