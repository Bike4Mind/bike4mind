import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminRevenueResponse, RevenueRange } from '@client/app/utils/adminRevenue';

export const ADMIN_REVENUE_PATH = '/api/admin/revenue';

export function useAdminRevenue(range: RevenueRange) {
  return useQuery({
    queryKey: ['admin', 'revenue', range],
    queryFn: async () => (await api.get<AdminRevenueResponse>(ADMIN_REVENUE_PATH, { params: { range } })).data,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}
