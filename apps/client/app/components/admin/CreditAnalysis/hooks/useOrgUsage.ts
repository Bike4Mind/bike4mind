import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IOrgUsageDashboardResponse } from '@bike4mind/common';

/**
 * One organization's AI spend summary (burn chart + member/model/feature cuts).
 * Disabled until an org is selected. Access is enforced server-side (admins
 * cross-org; an org's owner/manager scoped to their org), so this fires for any
 * authenticated caller and the server 404s an org they can't see.
 */
export const useOrgUsage = (organizationId: string | null, days: number) => {
  return useQuery({
    queryKey: ['org-usage', organizationId, days],
    queryFn: async () => {
      const { data } = await api.get<IOrgUsageDashboardResponse>('/api/admin/org-usage', {
        params: { organizationId, days },
      });
      return data;
    },
    enabled: !!organizationId,
    staleTime: 1000 * 60 * 5,
  });
};
