import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AdminUserSession } from '@bike4mind/common';

const sessionsKey = (userId: string) => ['admin', 'users', userId, 'sessions'] as const;

/** A user's active (unrevoked, unexpired) sessions, most recently used first. */
export const useUserSessions = (userId: string) =>
  useQuery({
    queryKey: sessionsKey(userId),
    queryFn: async (): Promise<AdminUserSession[]> => {
      const response = await api.get<{ items: AdminUserSession[] }>(
        `/api/admin/users/${encodeURIComponent(userId)}/sessions`
      );
      return response.data.items;
    },
    staleTime: 1000 * 30,
  });

/**
 * Revokes one session (`sid`) or, with no sid, every session plus trusted devices via the existing
 * force-logout route. Both are audited with the reason. Invalidates the whole user subtree so the
 * sessions list, sign-ins and timeline pick up the new audit rows.
 */
export const useRevokeUserSessions = (userId: string) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sid, reason }: { sid?: string; reason: string }) => {
      const id = encodeURIComponent(userId);
      if (sid) {
        await api.delete(`/api/admin/users/${id}/sessions`, { params: { sid }, data: { reason } });
        return;
      }
      await api.post(`/api/users/${id}/revoke-sessions`, { reason });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
  });
};
