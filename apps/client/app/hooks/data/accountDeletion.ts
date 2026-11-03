import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { tearDownClientSession } from '@client/app/hooks/data/user';
import type { IUserDeletion } from '@bike4mind/common';

export const ACCOUNT_DELETION_QUERY_KEY = ['account', 'deletion'] as const;

export type OwnedOrganization = { id: string; name: string };

export type AccountDeletionStatus = {
  deletion: IUserDeletion | null;
  ownedOrganizations: OwnedOrganization[];
};

/** The pending deletion, if any, and the organizations that block a new request (GET /api/account/deletion). */
export function useAccountDeletionStatus(enabled = true) {
  return useQuery({
    queryKey: ACCOUNT_DELETION_QUERY_KEY,
    queryFn: async () => (await api.get<AccountDeletionStatus>('/api/account/deletion')).data,
    enabled,
  });
}

/**
 * Schedule the account for deletion. The server signs out every device, this one included, so a
 * success tears the client session down and lands on /login.
 */
export function useRequestAccountDeletion() {
  const setCurrentUser = useUser(s => s.setCurrentUser);
  const resetTokens = useAccessToken(s => s.resetTokens);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<{ deletion: IUserDeletion }>('/api/account/deletion')).data,
    onSuccess: async () => {
      await tearDownClientSession({ setCurrentUser, resetTokens, queryClient });
    },
  });
}

/** Cancel a pending deletion, then reload so the app boots with full access again. */
export function useCancelAccountDeletion() {
  return useMutation({
    mutationFn: async () => {
      await api.delete('/api/account/deletion');
    },
    onSuccess: () => {
      window.location.replace('/');
    },
  });
}
