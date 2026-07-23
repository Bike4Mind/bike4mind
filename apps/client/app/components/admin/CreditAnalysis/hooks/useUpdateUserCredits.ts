import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export function useUpdateUserCredits() {
  return useMutation({
    mutationFn: async ({ userId, credits, note }: { userId: string; credits: number; note?: string }) => {
      const response = await api.put(`/api/users/${userId}/update`, {
        currentCredits: credits,
        // Persisted on the audited CreditTransaction (server defaults a description
        // when omitted). Previously sent as `adminNote`, which the schema dropped.
        creditReason: note,
      });
      return response.data;
    },
  });
}
