import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { ISessionUsageResponse } from '@bike4mind/common';

/**
 * One session's usage detail (by-quest / by-model spend + per-agent-execution
 * iteration billing). Admin-gated; disabled until a session id is provided
 * (i.e. the detail modal is opened for a row).
 */
export const useSessionUsage = (sessionId: string | null) => {
  const isAdmin = useUser(s => s.isAdmin);

  return useQuery({
    queryKey: ['admin-session-usage', sessionId],
    queryFn: async () => {
      const { data } = await api.get<ISessionUsageResponse>('/api/admin/session-usage', {
        params: { sessionId },
      });
      return data;
    },
    enabled: isAdmin && !!sessionId,
    staleTime: 1000 * 60,
  });
};
