import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { IOrgUsageDashboardResponse } from '@bike4mind/common';

/**
 * One organization's AI spend summary (burn chart + member/model/feature cuts).
 * Gated to admins and to a selected org; disabled until both hold.
 */
export const useOrgUsage = (organizationId: string | null, days: number) => {
  const isAdmin = useUser(s => s.isAdmin);

  return useQuery({
    queryKey: ['org-usage', organizationId, days],
    queryFn: async () => {
      const { data } = await api.get<IOrgUsageDashboardResponse>('/api/admin/org-usage', {
        params: { organizationId, days },
      });
      return data;
    },
    enabled: isAdmin && !!organizationId,
    staleTime: 1000 * 60 * 5,
  });
};
