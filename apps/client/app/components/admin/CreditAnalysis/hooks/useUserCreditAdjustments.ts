import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { IUserCreditAdjustment } from '@client/pages/api/admin/users/[userId]/credit-transactions';

// Re-exported under the established local name; sourced from the endpoint so
// the row shape cannot drift from what the API actually returns.
export type UserCreditAdjustment = IUserCreditAdjustment;

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
