import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IUsageDashboardResponse, UsageOwnerType } from '@bike4mind/common';

/**
 * One owner's AI spend summary (burn chart + member/model/feature cuts) for a
 * User or Organization owner. Disabled until an owner id is known. Access is
 * enforced server-side (admins see any owner; an org's owner/manager and a user
 * their own id), so this fires for any authenticated caller and the server
 * rejects an owner they can't see.
 */
export const useOwnerUsage = (ownerType: UsageOwnerType, ownerId: string | null, days: number) => {
  return useQuery({
    queryKey: ['owner-usage', ownerType, ownerId, days],
    queryFn: async () => {
      const { data } = await api.get<IUsageDashboardResponse>('/api/usage', {
        params: { ownerType, ownerId, days },
      });
      return data;
    },
    enabled: !!ownerId,
    staleTime: 1000 * 60 * 5,
  });
};
