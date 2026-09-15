import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export function useUpdateUserCredits() {
  return useMutation({
    mutationFn: async ({ userId, creditDelta, note }: { userId: string; creditDelta: number; note?: string }) => {
      const response = await api.put(`/api/users/${userId}/update`, {
        // Signed delta, not an absolute balance: the server applies it atomically so
        // spend between page load and this write is never refunded (see adminUpdateUser).
        creditDelta,
        // Persisted on the audited CreditTransaction (server defaults a description
        // when omitted). Previously sent as `adminNote`, which the schema dropped.
        creditReason: note,
      });
      return response.data;
    },
  });
}
