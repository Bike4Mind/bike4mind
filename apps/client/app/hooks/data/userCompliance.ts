import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { UserComplianceResponse } from '@bike4mind/common';

/** Fetch a user's read-only compliance evidence. */
export const useGetUserCompliance = (userId: string | null) => {
  return useQuery({
    queryKey: ['admin', 'user-compliance', userId],
    queryFn: async () => {
      if (!userId) throw new Error('userId is required');
      const response = await api.get<UserComplianceResponse>(`/api/admin/users/${userId}/compliance`);
      return response.data;
    },
    enabled: !!userId,
    staleTime: 1000 * 60, // 1 minute
  });
};
