import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface UserCreditAdjustment {
  id: string;
  createdAt: string;
  /** Signed delta: positive for a grant, negative for a deduction. */
  credits: number;
  description?: string;
  reason?: string;
  actorId?: string;
  actorName?: string;
  resultingBalance?: number;
}

export const userCreditAdjustmentsKey = (userId?: string) => ['admin', 'user-credit-adjustments', userId];

/**
 * Admin audit trail of manual credit adjustments (grants/deductions) for one
 * user. Gated on `enabled` so the query only runs while the modal is open.
 */
export function useUserCreditAdjustments(userId?: string, enabled = true) {
  return useQuery({
    queryKey: userCreditAdjustmentsKey(userId),
    enabled: !!userId && enabled,
    queryFn: async () => {
      const res = await api.get<{ rows: UserCreditAdjustment[] }>(`/api/admin/users/${userId}/credit-transactions`);
      return res.data.rows;
    },
  });
}
