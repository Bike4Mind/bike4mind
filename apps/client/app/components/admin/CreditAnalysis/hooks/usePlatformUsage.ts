import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { CompletionSource, IPlatformUsageDashboardResponse, UsageOwnerType } from '@bike4mind/common';

export type PlatformUsageFilters = {
  days: number;
  /** Omitted = all sources. */
  source?: CompletionSource;
  /** Omitted = all owner types. */
  ownerType?: UsageOwnerType;
};

/** Platform-wide usage for the admin API Usage view. Admin-only; the server 403s anyone else. */
export const usePlatformUsage = ({ days, source, ownerType }: PlatformUsageFilters) => {
  return useQuery({
    queryKey: ['platform-usage', days, source ?? null, ownerType ?? null],
    queryFn: async () => {
      const { data } = await api.get<IPlatformUsageDashboardResponse>('/api/admin/platform-usage', {
        params: { days, source, ownerType },
      });
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
};
