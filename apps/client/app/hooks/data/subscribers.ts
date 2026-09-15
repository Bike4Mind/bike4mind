import { useQuery } from '@tanstack/react-query';
import { fetchWaitingSubscribersCount } from '@client/app/utils/subscriberAPICalls';

export const useGetWaitingSubscribersCount = (options: { enabled?: boolean } = {}) => {
  const { enabled = true } = options;

  return useQuery({
    queryKey: ['subscribers', 'waiting-count'],
    queryFn: fetchWaitingSubscribersCount,
    enabled,
    refetchInterval: 30000, // Refetch every 30 seconds to keep count updated
    staleTime: 20000, // Consider data stale after 20 seconds
  });
};
