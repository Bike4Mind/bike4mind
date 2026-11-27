import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminUserOAuthApps } from '@bike4mind/common';

/** The client a user signed up through and the apps they sign in to. */
export const useAdminUserOAuthApps = (userId: string) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'oauth-apps'],
    queryFn: async (): Promise<AdminUserOAuthApps> =>
      (await api.get<AdminUserOAuthApps>(`/api/admin/users/${encodeURIComponent(userId)}/oauth-apps`)).data,
    staleTime: 1000 * 30,
  });
