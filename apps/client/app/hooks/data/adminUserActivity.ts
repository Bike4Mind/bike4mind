import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { UserActivityDirection, UserActivityPage, UserCreditHistory } from '@bike4mind/common';
import { reviveAuditEntry, type WireAuditEntry } from './adminAuditLog';

const DEFAULT_PAGE_SIZE = 50;

type WireUserActivityPage = Omit<UserActivityPage, 'entries'> & { entries: WireAuditEntry[] };

export const useUserActivity = (
  userId: string,
  options: { direction: UserActivityDirection; includeSecurity: boolean; enabled?: boolean }
) => {
  const { direction, includeSecurity, enabled = true } = options;
  return useInfiniteQuery({
    queryKey: ['admin', 'users', userId, 'activity', direction, includeSecurity],
    queryFn: async ({ pageParam }): Promise<UserActivityPage> => {
      const params: Record<string, string> = {
        direction,
        includeSecurity: String(includeSecurity),
        limit: String(DEFAULT_PAGE_SIZE),
      };
      if (pageParam) params.cursor = pageParam;
      const response = await api.get<WireUserActivityPage>(`/api/admin/users/${encodeURIComponent(userId)}/activity`, {
        params,
      });
      return {
        ...response.data,
        entries: response.data.entries.map(reviveAuditEntry),
      };
    },
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
    staleTime: 1000 * 30,
    enabled,
  });
};

export const useUserCreditHistory = (userId: string, options: { enabled?: boolean } = {}) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'credit-history'],
    queryFn: async (): Promise<UserCreditHistory> => {
      const response = await api.get<UserCreditHistory>(
        `/api/admin/users/${encodeURIComponent(userId)}/credit-history`
      );
      return response.data;
    },
    staleTime: 1000 * 60,
    enabled: options.enabled ?? true,
  });
