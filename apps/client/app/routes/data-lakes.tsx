import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ISessionDocument } from '@bike4mind/common';
import DataLakeExplorer from '@client/app/components/datalake/DataLakeExplorer';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { api } from '@client/app/contexts/ApiContext';

// Per-browser pointer to the user's datalake chat session, reused across loads so opening the
// surface doesn't mint a fresh empty session every visit. (#836)
const DATALAKE_SESSION_KEY = 'dataLakeSessionId';

/**
 * Data Lakes home - the top-level, Opti-independent destination for a user's OWN
 * lakes: browse (the unified Explorer reading `/api/data-lakes/*`, which sees the
 * user's dynamic DB lakes) + manage (create / add files / archive / restore /
 * delete). Reachable by any user with the EnableDataLakes admin flag, Opti or not.
 *
 * Chat-first (#836): the RIGHT pane hosts a real, grounded AI chat via `chatSlot`.
 * This page (the parent) owns the session id - it pre-creates a grounded data-lake
 * session and passes it to `SessionContainer`. Pre-creating keeps SessionContainer on
 * its existing-session path, so the `session.created` handler never navigates away to
 * `/notebooks/$id` on the first message. Clicking a file in the tree opens the rich
 * `KnowledgeModal` viewer (handled inside DataLakeExplorer when `chatSlot` is set).
 *
 * The management panel + wizard modals are store-driven singletons already mounted
 * globally by ProviderBundle (Files/Browser). We only drive them via the store
 * (`openManager`); mounting our own copies here would stack a second modal on the
 * same `isManagerOpen`/`isOpen` flag.
 */
export default function DataLakesHome() {
  const navigate = useNavigate();
  const { article } = useSearch({ strict: false }) as { article?: string };
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const queryClient = useQueryClient();

  const [sessionId, setSessionId] = useState<string | null>(null);
  // Guards the create against React StrictMode's double-invoke and re-renders.
  const creatingRef = useRef(false);

  // Pre-create the grounded data-lake session once. `forceKnowledgeRetrieval` with no
  // `retrievalTags` grounds every turn across ALL of the user's accessible lakes (no lake
  // picker); `surface` scopes the session to this product surface. The endpoint already
  // accepts these generic session fields (CreateSessionRequestSchema), so no server change.
  useEffect(() => {
    if (sessionId || creatingRef.current) return;
    creatingRef.current = true;
    void (async () => {
      try {
        // Reuse the last datalake session if it still exists; otherwise create one. Reuse
        // avoids minting an empty session on every visit (they'd pile up in the sidebar).
        const savedId = localStorage.getItem(DATALAKE_SESSION_KEY);
        if (savedId) {
          try {
            const { data } = await api.get<ISessionDocument>(`/api/sessions/${savedId}`);
            queryClient.setQueryData(['sessions', savedId], data);
            setSessionId(savedId);
            return;
          } catch {
            localStorage.removeItem(DATALAKE_SESSION_KEY); // stale/gone - fall through to create
          }
        }
        const { data } = await api.post<ISessionDocument>('/api/sessions/create', {
          name: 'Data Lake',
          surface: 'datalake',
          forceKnowledgeRetrieval: true,
        });
        queryClient.setQueryData(['sessions', data.id], data);
        localStorage.setItem(DATALAKE_SESSION_KEY, data.id);
        setSessionId(data.id);
      } catch {
        creatingRef.current = false; // allow a retry on the next render
        toast.error("Couldn't start the data lake chat - please try again.");
      }
    })();
  }, [sessionId, queryClient]);

  // Render the embedded chat inline and full-pane: `hide` shows the chat without the
  // KnowledgeViewer split and without the docked chrome whose controls mutate this same
  // global layout store (which would tear the chat out of the pane). Mirrors notebooks/new.
  useEffect(() => {
    setSessionLayout({ layout: 'hide' });
  }, []);

  // Legacy "Ask about this article" path (only reachable via the fallback DataLakeArticle,
  // which is not rendered here since `chatSlot` is set). Kept to satisfy the prop contract.
  const handleAskAbout = useCallback(
    (prompt: string) => {
      useChatInput.getState().setChatInputValue(prompt);
      navigate({ to: '/new' });
    },
    [navigate]
  );

  return (
    <NotebookFilepondProvider>
      <DataLakeExplorer
        source="datalakes"
        rootLabel="Data Lakes"
        articleId={article ?? null}
        onBack={() => navigate({ to: '/new' })}
        onAskAbout={handleAskAbout}
        onManage={openManager}
        chatSlot={
          <SessionContainer currentSessionId={sessionId ?? undefined} isLoading={!sessionId} autoHideOnEmpty={false} />
        }
      />
    </NotebookFilepondProvider>
  );
}
