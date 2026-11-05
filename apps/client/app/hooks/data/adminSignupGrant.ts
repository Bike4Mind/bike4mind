import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminSignupGrantPending } from '@bike4mind/common';

const userPath = (userId: string) => `/api/admin/users/${encodeURIComponent(userId)}`;

export const SIGNUP_GRANT_ACTION_PATH = {
  releaseHeld: 'release-held-signup-grant',
  releaseRemaining: 'unlock-signup-grant',
  block: 'block-signup-grant',
  unblock: 'unblock-signup-grant',
} as const;
export type SignupGrantAction = keyof typeof SIGNUP_GRANT_ACTION_PATH;

/** What every signup grant action route answers; a no-op carries the reason it changed nothing. */
export type SignupGrantActionResponse =
  { outcome: 'applied'; credits: number; rewardsAffected?: number } | { outcome: 'noop'; reason: string };

/** Block state is only readable here: the user's own payload and the profile copy never carry it. */
export const useAdminSignupGrantPending = (userId: string) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'signup-grant-pending'],
    queryFn: async (): Promise<AdminSignupGrantPending> => {
      const response = await api.get<AdminSignupGrantPending>(`${userPath(userId)}/signup-grant-pending`);
      return response.data;
    },
    staleTime: 1000 * 30,
  });

/** Runs one audited action; the panel, the balance and the ledger refresh whatever the outcome. */
export const useAdminSignupGrantAction = (userId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      action,
      reason,
    }: {
      action: SignupGrantAction;
      reason: string;
    }): Promise<SignupGrantActionResponse> => {
      const response = await api.post<SignupGrantActionResponse>(
        `${userPath(userId)}/${SIGNUP_GRANT_ACTION_PATH[action]}`,
        { reason }
      );
      return response.data;
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId, 'signup-grant-pending'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId, 'credit-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId, 'credit-ledger'] }),
        queryClient.invalidateQueries({ queryKey: ['users'] }),
      ]),
  });
};
