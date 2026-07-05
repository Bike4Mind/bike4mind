import { useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export function useUpdateUserCredits() {
  return useMutation({
    mutationFn: async ({ userId, credits, note }: { userId: string; credits: number; note?: string }) => {
      const response = await api.put(`/api/users/${userId}/update`, {
        currentCredits: credits,
        adminNote: note ? `Credit adjustment: ${note}` : 'Credit adjustment by admin',
      });
      return response.data;
    },
  });
}
