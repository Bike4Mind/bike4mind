import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminRevenueResponse, AdminRevenueTrendResponse, RevenueRange } from '@client/app/utils/adminRevenue';

export const ADMIN_REVENUE_PATH = '/api/admin/revenue';

export function useAdminRevenue(range: RevenueRange) {
  return useQuery({
    queryKey: ['admin', 'revenue', range],
    queryFn: async () => (await api.get<AdminRevenueResponse>(ADMIN_REVENUE_PATH, { params: { range } })).data,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export const ADMIN_REVENUE_TREND_PATH = '/api/admin/revenue/trend';

export function useAdminRevenueTrend({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['admin', 'revenue', 'trend'],
    queryFn: async () => (await api.get<AdminRevenueTrendResponse>(ADMIN_REVENUE_TREND_PATH)).data,
    enabled,
    // Snapshots are written once a day.
    staleTime: 5 * 60_000,
  });
}
