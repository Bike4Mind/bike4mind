import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminUserRiskFlags } from '@bike4mind/common';

export const userRiskFlagsQueryKey = (userId: string) => ['admin', 'users', userId, 'risk-flags'] as const;

export const useUserRiskFlags = (userId: string) =>
  useQuery({
    queryKey: userRiskFlagsQueryKey(userId),
    queryFn: async (): Promise<AdminUserRiskFlags> => {
      const response = await api.get<AdminUserRiskFlags>(`/api/admin/users/${encodeURIComponent(userId)}/risk-flags`);
      return response.data;
    },
    staleTime: 1000 * 60,
  });
