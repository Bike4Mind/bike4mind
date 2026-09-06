import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ISessionDocument, DataLakeGroundingMode } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { updateAllQueryData } from '@client/app/utils/react-query';

type SessionCreateDeps = {
  queryClient: ReturnType<typeof useQueryClient>;
  setCurrentSession: (session: ISessionDocument) => void;
  setCurrentSessionId: (id: string) => void;
  closeManager: () => void;
  navigate: ReturnType<typeof useNavigate>;
};

async function createAndOpenSession(
  body: Record<string, unknown>,
  { queryClient, setCurrentSession, setCurrentSessionId, closeManager, navigate }: SessionCreateDeps
): Promise<ISessionDocument> {
  const res = await api.post<ISessionDocument>('/api/sessions/create', body);
  const created = res.data;
  queryClient.setQueryData(['sessions', created.id], created);
  updateAllQueryData(queryClient, 'sessions', 'write', created, { keysAllowedToCreate: [['sessions', 'own']] });
  setCurrentSession(created);
  setCurrentSessionId(created.id);
  closeManager();
  navigate({ to: '/notebooks/$id', params: { id: created.id }, replace: true });
  return created;
}

/**
 * Starts a chat scoped to a SINGLE data lake: creates a session with `dataLakeId`, so the
 * server-side resolver seeds the lake's session defaults (forced retrieval scoped to the lake +
 * its preferred prompt id - see resolveLakeSessionDefaults). Distinct from useCreateDataLakeSession,
 * which starts the GLOBAL all-accessible-lakes grounding mode and binds no specific lake.
 *
 * Adopts the new session as current, seeds the react-query caches (same as the other create
 * seams), closes the lake manager, and navigates to the notebook. Throws on API failure so the
 * caller can surface its own error UX.
 *
 * NOTE (design follow-up): the entry point that calls this lives in the lake manager's info panel
 * for now - deliberately minimal. Placement/polish (e.g. a reader-facing lake card action) is left
 * to design; the create-time capability is surface-agnostic, so moving the button changes nothing here.
 */
export default function useStartChatWithLake() {
  const { setCurrentSession, setCurrentSessionId } = useSessions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const closeManager = useDataLakeWizardStore(s => s.closeManager);

  return useCallback(
    async (dataLakeId: string): Promise<ISessionDocument> =>
      createAndOpenSession(
        { name: 'New Notebook', dataLakeId },
        { queryClient, setCurrentSession, setCurrentSessionId, closeManager, navigate }
      ),
    [navigate, queryClient, setCurrentSession, setCurrentSessionId, closeManager]
  );
}

/**
 * Multi-lake counterpart, for testing a lake's scoping alongside (or against) its neighbors.
 * There is no `dataLakeId` for a subset, so this sends the same request shape an API-key caller
 * sends to reach the same scope: `retrievalTags` (one `datalakeTag` per lake) plus
 * `forceKnowledgeRetrieval` and `corpusGroundingMode` set explicitly. Both are required here
 * because resolveLakeSessionDefaults only derives them for the single-lake `dataLakeId` path
 * (sessionService/resolveLakeSessionDefaults.ts), and /api/sessions/create deletes any
 * client-sent `corpusGroundingMode` unless `dataLakeId` is present - a subset request that omitted
 * these would silently create an unscoped, non-retrieving session.
 */
export function useStartChatWithLakes() {
  const { setCurrentSession, setCurrentSessionId } = useSessions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const closeManager = useDataLakeWizardStore(s => s.closeManager);

  return useCallback(
    async (params: {
      retrievalTags: string[];
      corpusGroundingMode: DataLakeGroundingMode;
    }): Promise<ISessionDocument> =>
      createAndOpenSession(
        {
          name: 'New Notebook',
          retrievalTags: params.retrievalTags,
          forceKnowledgeRetrieval: true,
          corpusGroundingMode: params.corpusGroundingMode,
        },
        { queryClient, setCurrentSession, setCurrentSessionId, closeManager, navigate }
      ),
    [navigate, queryClient, setCurrentSession, setCurrentSessionId, closeManager]
  );
}
