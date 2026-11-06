import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  AdminSignupGrantPending,
  AdminSignupGrantPendingList,
  AdminSignupGrantPendingSummary,
} from '@bike4mind/common';

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
        queryClient.invalidateQueries({ queryKey: ['users', userId] }),
      ]),
  });
};

export type PendingListFilters = {
  status?: 'held' | 'dripping' | 'locked' | 'blocked';
  heldReason?: 'budget_exhausted' | 'risk_review';
  source?: 'default' | 'package';
  sort: 'oldest' | 'remaining';
};

/** Every pending-grant read sits under this prefix, so one invalidation refreshes the list and the summary. */
export const PENDING_GRANTS_QUERY_KEY = ['admin', 'signup-grants'] as const;

export const useAdminSignupGrantPendingList = (filters: PendingListFilters) =>
  useInfiniteQuery({
    queryKey: [...PENDING_GRANTS_QUERY_KEY, 'pending', filters],
    queryFn: async ({ pageParam }): Promise<AdminSignupGrantPendingList> => {
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(filters)) if (value !== undefined) params[key] = value;
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<AdminSignupGrantPendingList>('/api/admin/signup-grants/pending', { params });
      return response.data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
  });

export const useAdminSignupGrantPendingSummary = () =>
  useQuery({
    queryKey: [...PENDING_GRANTS_QUERY_KEY, 'pending-summary'],
    queryFn: async (): Promise<AdminSignupGrantPendingSummary> => {
      const response = await api.get<AdminSignupGrantPendingSummary>('/api/admin/signup-grants/pending-summary');
      return response.data;
    },
    staleTime: 1000 * 30,
  });
