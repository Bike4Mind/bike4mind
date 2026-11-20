import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { BillingOverview, BillingOwnerType, BillingRange } from '@client/app/utils/adminBillingOverview';

export const adminBillingOverviewQueryKey = (ownerType: BillingOwnerType, ownerId: string, range: BillingRange) =>
  ['admin', 'billing-overview', ownerType, ownerId, range] as const;

/** One owner's read-only billing summary (pages/api/admin/billing-overview.ts). */
export const useAdminBillingOverview = (
  ownerType: BillingOwnerType,
  ownerId: string,
  range: BillingRange,
  { enabled = true }: { enabled?: boolean } = {}
) =>
  useQuery({
    queryKey: adminBillingOverviewQueryKey(ownerType, ownerId, range),
    queryFn: async (): Promise<BillingOverview> => {
      const response = await api.get<BillingOverview>('/api/admin/billing-overview', {
        params: { ownerType, ownerId, range },
      });
      return response.data;
    },
    staleTime: 1000 * 60,
    placeholderData: keepPreviousData,
    enabled,
  });
