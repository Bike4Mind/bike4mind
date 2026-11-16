import { api } from '@client/app/contexts/ApiContext';
import type { OrgInvoicesResponse } from '@client/app/utils/orgInvoices';
import { useQuery } from '@tanstack/react-query';

export const orgInvoicesQueryKey = (orgId: string) => ['organizations', orgId, 'invoices'] as const;

/** The org's most recent invoices (GET /api/organizations/:id/invoices, org owner only). */
export function useOrgInvoices(orgId: string | null | undefined) {
  return useQuery({
    queryKey: orgInvoicesQueryKey(orgId ?? ''),
    queryFn: async () => {
      const { data } = await api.get<OrgInvoicesResponse>(`/api/organizations/${orgId}/invoices`);
      return data;
    },
    enabled: !!orgId,
  });
}
