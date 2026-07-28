import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { IFabFileDocument } from '@bike4mind/common';
import { useSessions, useWorkBenchStore } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { isOptimisticId } from '@client/app/utils/llm';

/**
 * The write path for a notebook's context files (`session.knowledgeIds`).
 *
 * The composer and file-manager paths write through here. The older idiom they
 * replaced computed the new id list from a captured `currentSession`, which loses a
 * concurrent write, and persisted through a fire-and-forget helper that swallowed
 * failures - a silent no-op is the worst possible outcome for a feature whose entire
 * symptom is a file quietly missing from context.
 *
 * It is NOT yet the only writer. Roughly a dozen other surfaces still set
 * `knowledgeIds` through `setCurrentSession` (Drive add, file browser, artifact and
 * snippet cards, the workbench strip, paste) and keep the old captured-session idiom.
 * They are safe from the propagation-leak class because the server only propagates the
 * files a write ADDS, but they remain exposed to the lost-update race. Migrating them
 * is follow-on work, not something this doc comment should pretend is done.
 *
 * `propagateToProjects` is threaded to the server deliberately. An upload that lands
 * in notebook context by DEFAULT has consented to this notebook, not to every project
 * that contains it - see sessionService/update.ts.
 */
export interface AddToNotebookContextOptions {
  /**
   * False for automatic promotion (an upload that was never explicitly marked for the
   * whole notebook). Defaults to true, matching every deliberate user gesture.
   */
  propagateToProjects?: boolean;
}

export function useNotebookContextFiles() {
  const { setCurrentSessionRaw } = useSessions();
  const setWorkBenchFiles = useWorkBenchStore(s => s.setWorkBenchFiles);
  const updateSession = useUpdateSession();

  // Tracks which files have a write in flight, purely so callers can disable a control
  // while it runs. It is NOT the de-duplication guard - the optimistic append below is a
  // synchronous store write, so a second concurrent call already sees the file present
  // and returns on the contents check. The ref mirrors the state because the state
  // setter is async and a rapid second call would otherwise read a stale set.
  const inFlightRef = useRef<Set<string>>(new Set());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const markPending = useCallback((fileId: string, pending: boolean) => {
    if (pending) inFlightRef.current.add(fileId);
    else inFlightRef.current.delete(fileId);
    setPendingIds(new Set(inFlightRef.current));
  }, []);

  /**
   * Persists whatever the workbench holds NOW. Reading the store at call time rather
   * than taking an id list argument is what keeps two concurrent adds from clobbering
   * each other: the second write sees the first one's optimistic append.
   */
  const persist = useCallback(
    async (sessionId: string, propagateToProjects: boolean) => {
      const knowledgeIds = Array.from(
        new Set(
          useWorkBenchStore
            .getState()
            .getWorkBenchFiles(sessionId)
            .map(f => f.id)
        )
      );

      // An unsaved notebook has no server row yet. Its files ride along in the
      // create call (generateNewSession -> sessionCrud writes knowledgeIds), so
      // persisting here would 400 on a client-generated id.
      if (!sessionId || isOptimisticId(sessionId)) return knowledgeIds;

      await updateSession.mutateAsync({ id: sessionId, knowledgeIds, propagateToProjects });
      setCurrentSessionRaw(prev => (prev && prev.id === sessionId ? { ...prev, knowledgeIds } : prev));
      return knowledgeIds;
    },
    [updateSession, setCurrentSessionRaw]
  );

  const addToNotebookContext = useCallback(
    async (sessionId: string | null | undefined, fabFile: IFabFileDocument, options?: AddToNotebookContextOptions) => {
      const sid = sessionId ?? '';
      if (
        useWorkBenchStore
          .getState()
          .getWorkBenchFiles(sid)
          .some(f => f.id === fabFile.id)
      )
        return;

      markPending(fabFile.id, true);
      setWorkBenchFiles(sid, prev => [...prev, fabFile]);
      try {
        await persist(sid, options?.propagateToProjects ?? true);
      } catch (error) {
        setWorkBenchFiles(sid, prev => prev.filter(f => f.id !== fabFile.id));
        toast.error(`Could not add "${fabFile.fileName}" to this notebook`);
        throw error;
      } finally {
        markPending(fabFile.id, false);
      }
    },
    [markPending, setWorkBenchFiles, persist]
  );

  const removeFromNotebookContext = useCallback(
    async (sessionId: string | null | undefined, fabFileId: string) => {
      const sid = sessionId ?? '';
      const previous = useWorkBenchStore.getState().getWorkBenchFiles(sid);
      if (!previous.some(f => f.id === fabFileId)) return;

      markPending(fabFileId, true);
      setWorkBenchFiles(sid, prev => prev.filter(f => f.id !== fabFileId));
      try {
        // Never propagate on removal. The server propagates whatever knowledgeIds it
        // receives, and on a removal that is the SURVIVING files - so propagating here
        // would push files that were deliberately kept out of projects (an automatic
        // upload promotion) into them, as a side effect of deleting something else.
        // Nothing needs propagating anyway: project.fileIds is append-only.
        await persist(sid, false);
      } catch (error) {
        setWorkBenchFiles(sid, previous);
        toast.error('Could not remove that file from this notebook');
        throw error;
      } finally {
        markPending(fabFileId, false);
      }
    },
    [markPending, setWorkBenchFiles, persist]
  );

  const isPending = useCallback((fabFileId: string) => pendingIds.has(fabFileId), [pendingIds]);

  return { addToNotebookContext, removeFromNotebookContext, isPending };
}
