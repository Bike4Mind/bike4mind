import { useCallback } from 'react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { updateAllQueryData } from '@client/app/utils/react-query';

/**
 * Creates the Data Lake grounded session used when the mode is ON but no session exists yet:
 * a normal-surface session with `forceKnowledgeRetrieval: true` (surface intentionally omitted
 * so the chat stays in the main sidebar list - see datalake-in-chat-mode). Adopts it as the
 * current session, seeds the react-query caches, and swaps /new for the real notebook URL.
 *
 * Shared by the first-send seam (useSendMessage) and the explorer's file-click-on-/new path
 * so both create byte-identical sessions. Throws on API failure - callers own their error UX.
 */
export default function useCreateDataLakeSession() {
  const { setCurrentSession, setCurrentSessionId } = useSessions();
  const { projectId: routerProjectId } = useSearch({ strict: false }) as { projectId?: string };
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useCallback(
    async (extras?: { knowledgeIds?: string[] }): Promise<ISessionDocument> => {
      const res = await api.post<ISessionDocument>('/api/sessions/create', {
        name: 'New Notebook',
        forceKnowledgeRetrieval: true,
        // Files the session must be born holding (the explorer's open/attach-on-/new path):
        // adoption rehydrates the workbench FROM the session's knowledgeIds, so a file added
        // client-side after creation loses that race on slower adoption paths.
        ...(extras?.knowledgeIds?.length ? { knowledgeIds: extras.knowledgeIds } : {}),
        ...(routerProjectId ? { projectId: routerProjectId } : {}),
      });
      const created = res.data;
      queryClient.setQueryData(['sessions', created.id], created);
      updateAllQueryData(queryClient, 'sessions', 'write', created, { keysAllowedToCreate: [['sessions', 'own']] });
      setCurrentSession(created);
      setCurrentSessionId(created.id);
      if (location.pathname === '/new') {
        navigate({
          to: '/notebooks/$id',
          params: { id: created.id },
          search: routerProjectId ? { projectId: routerProjectId } : {},
          replace: true,
        });
      }
      // Match the invalidation set in `useGenerateNewSession.onSuccess` so a session created
      // while viewing a project refreshes that project's session list + activity feed
      // immediately, instead of waiting for the next unrelated refetch.
      if (routerProjectId) {
        queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', routerProjectId] });
        queryClient.invalidateQueries({ queryKey: ['projects', routerProjectId] });
        queryClient.invalidateQueries({ queryKey: ['activities'] });
      }
      return created;
    },
    [routerProjectId, location.pathname, navigate, queryClient, setCurrentSession, setCurrentSessionId]
  );
}
