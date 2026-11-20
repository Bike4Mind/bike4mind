import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminActionCounts } from '@client/app/components/admin/adminActionCounts';

/** Invalidate this after acting on a counted queue so its sidebar badge drops without waiting for the poll. */
export const adminActionCountsQueryKey = ['admin', 'action-counts'] as const;

const ADMIN_ACTION_COUNTS_POLL_MS = 60_000;

/** Every sidebar count in one request, polled while the admin console is open. */
export const useAdminActionCounts = ({ enabled }: { enabled: boolean }) =>
  useQuery({
    queryKey: adminActionCountsQueryKey,
    queryFn: async (): Promise<AdminActionCounts> =>
      (await api.get<{ counts: AdminActionCounts }>('/api/admin/action-counts')).data.counts,
    enabled,
    refetchInterval: ADMIN_ACTION_COUNTS_POLL_MS,
    staleTime: ADMIN_ACTION_COUNTS_POLL_MS / 2,
  });
