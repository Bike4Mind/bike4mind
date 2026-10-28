import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

type UpdateUserCreditsVars = { userId: string; note: string } & (
  { creditDelta: number; currentCredits?: undefined } | { currentCredits: number; creditDelta?: undefined }
);

export function useUpdateUserCredits() {
  return useMutation({
    mutationFn: async ({ userId, creditDelta, currentCredits, note }: UpdateUserCreditsVars) => {
      const response = await api.put(`/api/users/${userId}/update`, {
        // A delta is applied atomically so spend between page load and this write is never
        // refunded (see adminUpdateUser). An absolute balance is turned into a delta server-side.
        ...(creditDelta !== undefined ? { creditDelta } : { currentCredits }),
        // Required by the server (5..500 chars); persisted on the audited CreditTransaction.
        creditReason: note,
      });
      return response.data;
    },
  });
}
