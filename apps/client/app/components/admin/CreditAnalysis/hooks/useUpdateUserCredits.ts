import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export function useUpdateUserCredits() {
  return useMutation({
    mutationFn: async ({ userId, creditDelta, note }: { userId: string; creditDelta: number; note: string }) => {
      const response = await api.put(`/api/users/${userId}/update`, {
        // Signed delta, not an absolute balance: the server applies it atomically so
        // spend between page load and this write is never refunded (see adminUpdateUser).
        creditDelta,
        // Required by the server (5..500 chars); persisted on the audited CreditTransaction.
        creditReason: note,
      });
      return response.data;
    },
  });
}
