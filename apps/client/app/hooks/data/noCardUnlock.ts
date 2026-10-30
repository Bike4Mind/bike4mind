import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NoCardUnlockReason, NoCardUnlockRefusal } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { CREDITS_BALANCE_KEY } from './credits';

export interface NoCardUnlockResult {
  creditsGranted: number;
  currentCredits: number;
  refusal?: NoCardUnlockRefusal;
}

const ROUTES: Record<NoCardUnlockReason, string> = {
  github_verified: '/api/credits/no-card-unlock/github',
  work_email_verified: '/api/credits/no-card-unlock/work-email',
};

export function useNoCardUnlock() {
  const queryClient = useQueryClient();
  return useMutation<NoCardUnlockResult, Error, NoCardUnlockReason>({
    mutationFn: async reason => (await api.post<NoCardUnlockResult>(ROUTES[reason])).data,
    onSuccess: result => {
      if (result.creditsGranted > 0) {
        queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY });
        queryClient.invalidateQueries({ queryKey: ['credit-transactions'] });
      }
    },
  });
}
