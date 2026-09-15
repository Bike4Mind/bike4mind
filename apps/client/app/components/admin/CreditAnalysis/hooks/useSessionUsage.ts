import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { ISessionUsageResponse } from '@bike4mind/common';

/**
 * One session's usage detail (by-quest / by-model spend + per-agent-execution
 * iteration billing). Disabled until a session id is provided (i.e. the detail
 * modal is opened for a row). Pass organizationId for a non-admin org owner:
 * the server requires it to prove the session's spend belongs to their org.
 * Admins may omit it and read any session.
 */
export const useSessionUsage = (sessionId: string | null, organizationId?: string) => {
  return useQuery({
    queryKey: ['admin-session-usage', sessionId, organizationId],
    queryFn: async () => {
      const { data } = await api.get<ISessionUsageResponse>('/api/admin/session-usage', {
        params: { sessionId, ...(organizationId ? { organizationId } : {}) },
      });
      return data;
    },
    enabled: !!sessionId,
    staleTime: 1000 * 60,
  });
};
