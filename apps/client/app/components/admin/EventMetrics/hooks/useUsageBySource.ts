import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { UsageBySourceResponse } from '@bike4mind/common';

export type { UsageBySourceBucket, UsageBySourceResponse } from '@bike4mind/common';

const fetchUsageBySource = async (hours: number): Promise<UsageBySourceResponse> => {
  const response = await api.get(`/api/admin/usage-by-source?hours=${hours}`);
  return response.data;
};

export const useUsageBySource = (hours = 168) => {
  return useQuery({
    queryKey: ['admin', 'usage-by-source', hours],
    queryFn: () => fetchUsageBySource(hours),
    staleTime: 1000 * 60 * 5, // 5 minutes; admin metric, not real-time
  });
};
