import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface AdminAdjustmentRow {
  id: string;
  createdAt: string;
  /** Signed delta: positive for a grant, negative for a deduction. */
  credits: number;
  description?: string;
  reason?: string;
  actorId?: string;
  actorName?: string;
  targetUserId: string;
  targetUserName?: string;
  resultingBalance?: number;
}

export interface AdminAdjustmentsResponse {
  rows: AdminAdjustmentRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Global, paginated audit trail of admin credit adjustments across all users.
 * `days` narrows to a trailing window (undefined = all time).
 */
export function useCreditAdjustmentsLog({ page, limit, days }: { page: number; limit: number; days?: number }) {
  return useQuery({
    queryKey: ['admin', 'credit-adjustments', { page, limit, days }],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await api.get<AdminAdjustmentsResponse>('/api/admin/credit-adjustments', {
        params: { page, limit, ...(days ? { days } : {}) },
      });
      return res.data;
    },
  });
}
