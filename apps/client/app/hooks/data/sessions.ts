import {
  cloneSession,
  deleteSessionFromServer,
  bulkDeleteSessionsFromServer,
  generateNewSession,
  generateSessionSummary,
  generateSessionTags,
  getChatMessages,
  getFavoriteSessions,
  getSessionByIdFromServer,
  getSessionsFromServer,
  getSharedSessionsFromServer,
  updateSessionToServer,
} from '@client/app/utils/sessionsAPICalls';
import {
  InfiniteData,
  QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useUser } from '@client/app/contexts/UserContext';
import { toast } from 'sonner';
import {
  IChatHistoryItem,
  IChatHistoryItemDocument,
  ISessionDocument,
  ISessionFavoriteItem,
  FavoriteDocumentType,
} from '@bike4mind/common';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSessions, useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import { api } from '@client/app/contexts/ApiContext';
import { useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { updateAllQueryData, useSubscribeCollection } from '@client/app/utils/react-query';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useJobStatus } from '@client/app/hooks/useJobStatus';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { isOptimisticId } from '@client/app/utils/llm';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import { useSendToDataLakeStore } from '@client/app/stores/useSendToDataLakeStore';

export function useDeleteAllSessions(options: { onSuccess?: () => void } = {}) {
  const queryClient = useQueryClient();
  const { onSuccess } = options;

  return useMutation({
    mutationFn: async () => {
      await api.delete('/api/sessions');
      return null;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });

      if (onSuccess) onSuccess();
    },
    onError: error => {
      console.error(error);
      toast.error('Failed to download files');
    },
  });
}

export const OWN_SESSIONS_LIMIT = 20;
export function useGetOwnSessions(search: string = '', surface?: string) {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();

  return useInfiniteQuery({
    queryKey: ['sessions', 'own', search, surface ?? ''],
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};
      const result = await getSessionsFromServer(search, {
        pagination: {
          page,
          limit: OWN_SESSIONS_LIMIT,
        },
        surface,
      });

      result.data.forEach(session => {
        queryClient.setQueryData(['sessions', session.id], () => session);
      });
      return result;
    },
    enabled: !!currentUser,
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return {
          page: page + 1,
        };
      }
      return undefined;
    },
    // On remount, trim cached pages to page 1 (so we don't re-render stale
    // deep-paginated data) and return false so the mount itself doesn't trigger a
    // refetch. This replaces the removeQueries effect in CombinedNotebooks, which
    // evicted the in-flight query on cold mount and caused a duplicate fetch.
    // Mirrors useGetSharedSessions. The initial cold fetch (no cached data) still
    // runs once - refetchOnMount only governs refetch of EXISTING data.
    refetchOnMount: () => {
      queryClient.setQueryData<InfiniteData<{ data: ISessionDocument[]; hasMore: boolean }>>(
        ['sessions', 'own', search, surface ?? ''],
        data => {
          if (!data) {
            return;
          }
          return {
            pages: data.pages.slice(0, 1),
            pageParams: data.pageParams.slice(0, 1),
          };
        }
      );
      return false;
    },
    // Keep the sidebar list cached briefly so it doesn't refetch on every
    // remount (route change, sibling consumer mount). Mutations still call
    // invalidateQueries({ queryKey: ['sessions', 'own'] }), which refetches regardless of staleTime.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGetSharedSessions(search?: string) {
  const queryClient = useQueryClient();
  const { currentUser } = useUser();

  // Set true to use mock data for shared-notebooks UI testing
  const USE_MOCK_SHARED_NOTEBOOKS = false;

  return useInfiniteQuery({
    queryKey: ['sessions', 'shared', search],
    initialPageParam: { page: 1 },
    queryFn: async params => {
      const { page = 1 } = params.pageParam || {};

      if (USE_MOCK_SHARED_NOTEBOOKS && process.env.NODE_ENV === 'development') {
        const { getMockSharedSessionsResponse } = await import('@client/app/mocks/sharedNotebooks');
        const mockResult = getMockSharedSessionsResponse(search || '', page, 10, currentUser?.id || '');

        // Simulate network delay
        await new Promise(resolve => setTimeout(resolve, 300));

        mockResult.data.forEach(session => {
          queryClient.setQueryData(['sessions', session.id], session);
        });

        return mockResult;
      }

      const result = await getSharedSessionsFromServer(search, {
        pagination: {
          page,
          limit: 10,
        },
      });

      result.data.forEach(session => {
        queryClient.setQueryData(['sessions', session.id], session);
      });

      return result;
    },
    refetchOnMount: () => {
      queryClient.setQueryData<InfiniteData<{ data: ISessionDocument[]; hasMore: boolean }>>(
        ['sessions', 'shared', search],
        data => {
          if (!data) {
            return;
          }

          return {
            pages: data.pages.slice(0, 1),
            pageParams: data.pageParams.slice(0, 1),
          };
        }
      );

      return false;
    },
    enabled: !!currentUser,
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return {
          page: page + 1,
        };
      }
    },
    // Same as useGetOwnSessions - cache briefly to stop double-fetch on
    // remount. Shared-list mutations call invalidateQueries({ queryKey: ['sessions', 'shared'] }) explicitly.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useGetSessionQuests(sessionId: string | null) {
  const pendingOptimisticId = useSessionLayout(s => s.pendingOptimisticId);
  // Suppress the network request while the session is in the optimistic
  // pre-navigation window, or if the ID is still an optimistic placeholder -
  // hitting the server with a client-only ID would 500.
  //
  // Critically, we keep the queryKey scoped to the actual `sessionId`, NOT a
  // remapped `null`. `createOptimisticQuest` (utils/llm.ts) writes the user's
  // prompt + any `**Error:** ...` reply into `['quests', 'session', <tmpId>]`;
  // if we re-keyed to `null` here the component would read from a different
  // bucket and the optimistic content (including send-error replies) would
  // never surface in the chat.
  const isOptimistic = isOptimisticId(sessionId) || (!!pendingOptimisticId && sessionId === pendingOptimisticId);

  return useInfiniteQuery({
    queryKey: ['quests', 'session', sessionId],
    initialPageParam: { page: 1 },
    queryFn: async ({ pageParam }) => {
      const { page } = pageParam;
      return getChatMessages(sessionId!, {
        pagination: {
          page,
          limit: 10,
        },
        sort: 'desc',
      });
    },
    getNextPageParam: (lastPage, _allPages, { page }) => {
      if (lastPage.hasMore) {
        return {
          page: page + 1,
        };
      }
      return undefined;
    },
    enabled: !!sessionId && !isOptimistic,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useGetSession(sessionId: string | null) {
  return useQuery({
    queryKey: ['sessions', sessionId],
    enabled: !!sessionId && !isOptimisticId(sessionId),
    queryFn: () => getSessionByIdFromServer(sessionId!),
    staleTime: 1000 * 60 * 30, // 30 minutes
  });
}

export async function getOrFetchSession(queryClient: QueryClient, sessionId: string): Promise<ISessionDocument> {
  // Optimistic IDs are client-generated and won't resolve on the server.
  // Read from cache only - useSendMessage seeds the synthetic session there
  // before navigation, and the session.created WS handler later migrates it
  // to the real id. Throwing here surfaces the (unexpected) cache miss to the
  // caller as a typed error instead of a 404.
  if (isOptimisticId(sessionId)) {
    const cached = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
    if (cached) return cached;
    throw new Error(`No cached session for optimistic id ${sessionId}`);
  }
  return queryClient.ensureQueryData({
    queryKey: ['sessions', sessionId],
    queryFn: () => getSessionByIdFromServer(sessionId),
    staleTime: 1000 * 60 * 30,
  });
}

/**
 * Fetch multiple sessions by their IDs in parallel.
 * Used by semantic search to load sessions that may not be in the paginated list.
 */
export function useGetSessionsByIds(sessionIds: string[] | null) {
  const queries = useQueries({
    queries: (sessionIds ?? []).map(id => ({
      queryKey: ['sessions', id],
      queryFn: () => getSessionByIdFromServer(id),
      staleTime: 1000 * 60 * 30, // 30 minutes
      enabled: !!id,
    })),
  });

  // Combine results - filter out failed/loading queries
  const sessions = queries.filter(q => q.isSuccess && q.data).map(q => q.data as ISessionDocument);

  const isLoading = queries.some(q => q.isLoading);
  const isError = queries.some(q => q.isError);

  return { sessions, isLoading, isError };
}

export function useDeleteSession(successCallback?: (sessionId: string) => void) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      // OPTIMISTIC UPDATE
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', id]);
      if (session) {
        updateAllQueryData(queryClient, 'sessions', 'delete', session, {
          keysAllowedToCreate: [['sessions', 'own']],
        });
      }

      const { newLastNotebookId } = await deleteSessionFromServer(id);

      return {
        deletedNotebookId: id,
        newLastNotebookId,
      };
    },
    onError: e => {
      console.log(e);
      toast.error('Failed to delete session');
    },
    onSuccess: async ({ deletedNotebookId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions', 'own'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'shared'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'favorites'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'projects'] }),
        queryClient.invalidateQueries({ queryKey: ['favorites', deletedNotebookId, FavoriteDocumentType.Sessions] }),
        queryClient.invalidateQueries({ queryKey: ['quests', 'session', deletedNotebookId] }),
        queryClient.invalidateQueries({ queryKey: ['activities'] }),
      ]);
      toast.success('Successfully deleted session');
      successCallback?.(deletedNotebookId);
    },
  });
}

export function useDeleteSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionIds: string[]) => {
      // OPTIMISTIC UPDATE - remove all sessions from cache immediately
      for (const sessionId of sessionIds) {
        const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
        if (session) {
          updateAllQueryData(queryClient, 'sessions', 'delete', session, {
            keysAllowedToCreate: [['sessions', 'own']],
          });
        }
      }

      // Single API call for bulk delete
      const { deletedCount, newLastNotebookId } = await bulkDeleteSessionsFromServer(sessionIds);

      return {
        deletedCount,
        newLastNotebookId,
        deletedNotebookId: sessionIds[sessionIds.length - 1], // Last deleted session ID for navigation compatibility
      };
    },
    onError: e => {
      console.log(e);
      toast.error('Failed to delete sessions');
    },
    onSuccess: async ({ deletedCount }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions', 'own'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'shared'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'favorites'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', 'projects'] }),
        queryClient.invalidateQueries({ queryKey: ['activities'] }),
      ]);
      toast.success(`Successfully deleted ${deletedCount} notebook${deletedCount > 1 ? 's' : ''}`);
    },
  });
}

export function useGetFavoriteSessions() {
  return useQuery<ISessionFavoriteItem[]>({
    queryKey: ['sessions', 'favorites', 'list'],
    queryFn: () => getFavoriteSessions(),
    refetchOnWindowFocus: false,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * TODO: temporary - move favorite toggling to the server instead of updateSession.
 */
export function useToggleFavoriteSession(sessionId: string) {
  const queryClient = useQueryClient();
  const { data: favoriteSessions = [] } = useGetFavoriteSessions();
  const isFavorite = useMemo(
    () => favoriteSessions.some(favSession => favSession.id === sessionId),
    [favoriteSessions, sessionId]
  );

  return useMutation({
    mutationKey: ['sessions', 'favorite', sessionId],
    mutationFn: async () => {
      try {
        if (isFavorite) {
          await api.delete<ISessionDocument>(`/api/sessions/${sessionId}/favorite`);
        } else {
          await api.post<ISessionDocument>(`/api/sessions/${sessionId}/favorite`);
        }
      } catch (error) {
        console.error('Error toggling favorite:', error);
        throw error;
      }
    },
    onSuccess: () => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);

      // Invalidate the useCheckFavorite cache to trigger refetch
      queryClient.invalidateQueries({ queryKey: ['favorites', sessionId, FavoriteDocumentType.Sessions] });

      // Also invalidate the sessions favorites list if it exists
      queryClient.invalidateQueries({ queryKey: ['sessions', 'favorites'] });

      if (isFavorite) {
        toast.success(`Removed "${sessionName}" from favorites`);
      } else {
        toast.success(`Added "${sessionName}" to favorites`);
      }
    },
    onError: () => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);
      toast.error(`Failed to update favorites for "${sessionName}"`);
    },
  });
}

export function useUpdateSession(callback?: { onSuccess?: (session: ISessionDocument) => void }) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const result = (await updateSessionToServer(session)) as ISessionDocument;

      updateAllQueryData(queryClient, 'sessions', 'write', result, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
      return result;
    },
    onSuccess: callback?.onSuccess,
  });
}

export const useCloneSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const result = await cloneSession(sessionId);
      updateAllQueryData(queryClient, 'sessions', 'write', result, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
      return result;
    },
    onSuccess: result => {
      toast.success(`Successfully clone session ${formatSessionTitle(result.name)}`);
    },
  });
};

export const useDownloadSession = () => {
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const quests = await getChatMessages(session.id, { all: true });

      const title = formatSessionTitle(session.name);
      let dataString = title + '\n\n';
      quests.data.forEach((quest: IChatHistoryItem) => {
        dataString += 'User:' + quest.prompt + '\n';
        (quest.replies || []).forEach(reply => {
          dataString += 'AI:' + reply + '\n';
        });
        dataString += '\n';
      });
      const blob = new Blob([dataString], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `${title}.txt`);
      link.click();
    },
    onSuccess: (_, session) => {
      toast.success(`Downloaded "${formatSessionTitle(session.name)}" successfully`);
    },
    onError: (_, session) => {
      toast.error(`Failed to download "${formatSessionTitle(session.name)}"`);
    },
  });
};

/**
 * Build a filesystem/S3-safe filename base from a session name.
 * formatSessionTitle trims, strips wrapping quotes, and clamps length, but leaves
 * path separators and reserved characters (/ \ : * ? " < > |) that surprise downstream
 * S3 key handling - e.g. a session named `Bug: /api/foo broke?` -> `Bug- -api-foo broke-`.
 * Falls back to "session" if nothing printable survives.
 */
const sanitizeFilenameBase = (name: string): string =>
  formatSessionTitle(name)
    .replace(/[/\\:*?"<>|]/g, '-')
    .trim() || 'session';

/**
 * Groom a session's full conversation into a markdown document.
 * Shared by "Copy as Markdown" and "Send to Data Lake" so both produce identical output.
 */
const buildSessionMarkdown = (session: ISessionDocument, quests: IChatHistoryItem[]): string => {
  let markdown = `# ${formatSessionTitle(session.name)}\n\n`;
  quests.forEach((quest: IChatHistoryItem) => {
    markdown += `**User:** ${quest.prompt}\n\n`;
    (quest.replies || []).forEach(reply => {
      markdown += `**AI:** ${reply}\n\n`;
    });
    markdown += '---\n\n';
  });
  return markdown;
};

/**
 * Copy a session's conversation to the clipboard as markdown.
 */
export const useCopySessionAsMarkdown = () => {
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const quests = await getChatMessages(session.id, { all: true });
      const markdown = buildSessionMarkdown(session, quests.data);
      await navigator.clipboard.writeText(markdown);
      return markdown;
    },
    onSuccess: (_, session) => {
      toast.success(`Copied "${formatSessionTitle(session.name)}" to clipboard as markdown`);
    },
    onError: (_, session) => {
      toast.error(`Failed to copy "${formatSessionTitle(session.name)}" to clipboard`);
    },
  });
};

/**
 * Hook to send a whole session's conversation to a Data Lake.
 * Grooms the full session to markdown, then opens the app-level SendToDataLakeModal
 * (singleton in ProviderBundle) via the shared store - mirrors the reply-level send
 * in MessageContent.tsx, but for the entire session.
 */
export const useSendSessionToDataLake = () => {
  const openSendToDataLake = useSendToDataLakeStore(s => s.open);
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const quests = await getChatMessages(session.id, { all: true });
      const markdown = buildSessionMarkdown(session, quests.data);
      const filename = sanitizeFilenameBase(session.name);
      openSendToDataLake({
        content: markdown,
        fileName: `${filename}.md`,
        mimeType: 'text/markdown',
        sourceLabel: 'session',
      });
      return markdown;
    },
    onError: (_, session) => {
      toast.error(`Failed to prepare "${formatSessionTitle(session.name)}" for Data Lake`);
    },
  });
};

export const useSubscribeToSessionQuests = (sessionId?: string, isStreaming?: boolean) => {
  const queryClient = useQueryClient();
  const callback = useCallback(
    (type: string, data: IChatHistoryItemDocument) => {
      // PERFORMANCE FIX: Skip updates during active streaming to prevent double pipeline conflict
      if (isStreaming) {
        console.log(
          `🚫 [STREAMING] Skipping collection subscription update during active streaming for quest ${data.id}`
        );
        return;
      }

      const operation = type === 'delete' ? type : 'write';
      updateAllQueryData(queryClient, 'quests', operation, data, {
        keysAllowedToCreate: [['quests', 'session', data.sessionId]],
      });
    },
    [queryClient, isStreaming]
  );

  useSubscribeCollection(
    'quests',
    // PERFORMANCE FIX: Disable subscription entirely during streaming to prevent conflicts
    useMemo(() => (sessionId && !isStreaming ? { sessionId } : null), [sessionId, isStreaming]),
    callback,
    {
      fetchInitialData: false,
    }
  );
};

export const useSubscribeToSession = (sessionId?: string) => {
  const queryClient = useQueryClient();
  const prevSessionRef = useRef<ISessionDocument | null>(null);
  const { endJob, isJobRunning } = useJobStatus();

  // Initialize prevSessionRef with cached session data
  useEffect(() => {
    const cachedSession = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
    if (cachedSession && !prevSessionRef.current) {
      prevSessionRef.current = cachedSession;
    }
  }, [queryClient, sessionId]);

  const callback = useCallback(
    (type: string, val: ISessionDocument) => {
      const prevSession = prevSessionRef.current;

      // Detect job completion by comparing changes, so we only act once data is available
      if (prevSession && type !== 'delete' && val.id === prevSession.id) {
        // Check if summary was just added/updated
        const summaryJustCompleted =
          (!prevSession.summary && val.summary) || (prevSession.summaryAt !== val.summaryAt && val.summary);

        // Check if tags were just added/updated (only trigger on increases, not decreases)
        const tagsJustCompleted =
          (!prevSession.tags?.length && val.tags?.length) ||
          (prevSession.tags?.length && val.tags?.length && val.tags.length > prevSession.tags.length);

        // Clear job status when data is actually available and show success toast
        if (summaryJustCompleted && isJobRunning(val.id, 'summarize')) {
          endJob(val.id, 'summarize');
          toast.success(`Finished summarizing "${formatSessionTitle(val.name)}"`);
        }

        if (tagsJustCompleted && isJobRunning(val.id, 'generateTags')) {
          endJob(val.id, 'generateTags');
          toast.success(`Finished generating tags for "${formatSessionTitle(val.name)}"`);
        }
      }

      // Store current session for next comparison
      if (type !== 'delete') {
        prevSessionRef.current = { ...val };
      } else {
        prevSessionRef.current = null;
      }

      updateAllQueryData(queryClient, 'sessions', type === 'delete' ? 'delete' : 'write', val, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
    },
    [queryClient, endJob, isJobRunning]
  );

  const query = useMemo(() => (sessionId ? { _id: sessionId } : null), [sessionId]);

  useSubscribeCollection('sessionmodels', query, callback);
};
export const useSummarizeSession = () => {
  const queryClient = useQueryClient();
  const { startJob, endJob } = useJobStatus();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);

      // Start tracking the job globally
      startJob(sessionId, 'summarize');
      toast.success(`Started summarizing "${sessionName}"`);

      const result = await generateSessionSummary(sessionId);
      return result;
    },
    onError: (_, sessionId) => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);

      // Clear the job status on error
      endJob(sessionId, 'summarize');
      toast.error(`Failed to start summarizing "${sessionName}"`);
    },
  });
};

export const useUpdateSessionTags = () => {
  const queryClient = useQueryClient();
  const { startJob, endJob } = useJobStatus();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);

      // Start tracking the job globally
      startJob(sessionId, 'generateTags');
      toast.success(`Started generating tags for "${sessionName}"`);

      const result = await generateSessionTags(sessionId);
      return result;
    },
    onError: (_, sessionId) => {
      const session = queryClient.getQueryData<ISessionDocument>(['sessions', sessionId]);
      const sessionName = formatSessionTitle(session?.name);

      // Clear the job status on error
      endJob(sessionId, 'generateTags');
      toast.error(`Failed to start generating tags for "${sessionName}"`);
    },
  });
};

export const useCreateNewSession = (callbacks?: {
  onSuccess?: (session: ISessionDocument) => void;
  onError?: (err: Error) => void;
}) => {
  const queryClient = useQueryClient();
  const workBenchFiles = useWorkBenchFiles('');
  const { workBenchAgents = [] } = useSessions();
  const { t } = useTranslation();
  const { projectId } = useSearch({ strict: false }) as { projectId?: string };
  const model = useLLM(s => s.model);

  return useMutation({
    mutationFn: async () => {
      const newSessionName: string = `New ${t('llm.session')}`;
      const projectIdParam = projectId as string;
      const newSession = await generateNewSession(
        newSessionName,
        workBenchFiles.map(file => file.id),
        workBenchAgents.map(agent => agent.id),
        projectIdParam,
        model
      );

      return newSession;
    },
    onSuccess: session => {
      updateAllQueryData(queryClient, 'sessions', 'write', session, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: ['sessions', 'projects', projectId] });
        queryClient.invalidateQueries({ queryKey: ['projects', projectId] });
        queryClient.invalidateQueries({ queryKey: ['activities'] });
      }
      callbacks?.onSuccess?.(session);
    },
    onError: callbacks?.onError,
  });
};

export const useForkSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { sessionId: string; messageId: string }) => {
      const { sessionId, messageId } = params;
      const result = api
        .post<ISessionDocument>(`/api/sessions/${sessionId}/chat/${messageId}/fork`)
        .then(data => data?.data);
      return result;
    },
    onSuccess: result => {
      updateAllQueryData(queryClient, 'sessions', 'write', result, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
      toast.success('Session forked successfully');
    },
    onError: () => {
      toast.error('Failed to fork session');
    },
  });
};

export const useSnipSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { sessionId: string; messageId: string }) => {
      const { sessionId, messageId } = params;
      const result = api
        .post<ISessionDocument>(`/api/sessions/${sessionId}/chat/${messageId}/snip`)
        .then(data => data.data);

      return result;
    },
    onSuccess: result => {
      updateAllQueryData(queryClient, 'sessions', 'write', result, {
        keysAllowedToCreate: [['sessions', 'own']],
      });
      toast.success('Session snipped successfully');
    },
    onError: () => {
      toast.error('Failed to snip session');
    },
  });
};

export const useGetProjectSessions = (projectId: string) => {
  const queryClient = useQueryClient();

  return useQuery({
    queryKey: ['sessions', 'projects', projectId],
    queryFn: async () => {
      try {
        const response = await api.get<ISessionDocument[]>(`/api/projects/${projectId}/sessions`);

        response.data.forEach(session => {
          queryClient.setQueryData(['sessions', session.id], () => session);
        });

        return response.data;
      } catch (e) {
        return [];
      }
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchOnWindowFocus: false,
  });
};

export const useAutoRenameSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const result = await api.post<ISessionDocument>(`/api/sessions/${sessionId}/auto-rename`).then(data => data.data);
      return result;
    },
    onSuccess: result => {
      updateAllQueryData(queryClient, 'sessions', 'write', result, {
        keysAllowedToCreate: [
          ['sessions', 'own'],
          ['sessions', 'projects'],
        ],
      });
      toast.success('Notebook renamed successfully');
    },
    onError: () => {
      toast.error('Failed to rename notebook');
    },
  });
};

export const useCurrentSession = () => {
  const { currentSessionId } = useSessions();
  return useGetSession(currentSessionId);
};

/**
 * Hook to export a session to Excel format (.xlsx)
 */
export const useExportSessionToExcel = () => {
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const { toExportableSession, sessionToExcel, getSessionExportFilename } =
        await import('@client/app/utils/sessionExport');
      const quests = await getChatMessages(session.id, { all: true });
      const exportable = toExportableSession(session, quests.data);
      const filename = getSessionExportFilename(session.name);
      await sessionToExcel(exportable, filename);
    },
    onSuccess: (_, session) => {
      toast.success(`Exported "${formatSessionTitle(session.name)}" to Excel`);
    },
    onError: (_, session) => {
      toast.error(`Failed to export "${formatSessionTitle(session.name)}" to Excel`);
    },
  });
};

/**
 * Hook to export a session to Word format (.docx)
 */
export const useExportSessionToWord = () => {
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const { toExportableSession, sessionToDocx, getSessionExportFilename } =
        await import('@client/app/utils/sessionExport');
      const quests = await getChatMessages(session.id, { all: true });
      const exportable = toExportableSession(session, quests.data);
      const filename = getSessionExportFilename(session.name);
      await sessionToDocx(exportable, filename);
    },
    onSuccess: (_, session) => {
      toast.success(`Exported "${formatSessionTitle(session.name)}" to Word`);
    },
    onError: (_, session) => {
      toast.error(`Failed to export "${formatSessionTitle(session.name)}" to Word`);
    },
  });
};

/**
 * Hook to export a session to a self-contained, styled HTML document.
 * Renders the session's markdown through the shared markdown->HTML utility.
 */
export const useExportSessionToHtml = () => {
  return useMutation({
    mutationFn: async (session: ISessionDocument) => {
      const { toExportableSession, sessionToMarkdown, getSessionExportFilename } =
        await import('@client/app/utils/sessionExport');
      const { renderMarkdownToStyledHtml } = await import('@client/app/utils/markdownToStyledHtml');
      const { downloadFile } = await import('@client/app/components/common/DownloadMenu');
      const quests = await getChatMessages(session.id, { all: true });
      const exportable = toExportableSession(session, quests.data);
      const filename = getSessionExportFilename(session.name);
      const html = await renderMarkdownToStyledHtml(sessionToMarkdown(exportable), { title: session.name });
      downloadFile(html, `${filename}.html`, 'text/html');
    },
    onSuccess: (_, session) => {
      toast.success(`Exported "${formatSessionTitle(session.name)}" to HTML`);
    },
    onError: (_, session) => {
      toast.error(`Failed to export "${formatSessionTitle(session.name)}" to HTML`);
    },
  });
};
