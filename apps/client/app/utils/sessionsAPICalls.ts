import { api } from '@client/app/contexts/ApiContext';
import { SEND_REQUEST_TIMEOUT_MS } from '@client/app/utils/requestTimeouts';
import {
  IChatHistoryItem,
  IChatHistoryItemDocument,
  ISessionDocument,
  ISessionFavoriteItem,
  SessionListFilters,
  SessionUpdateRequest,
} from '@bike4mind/common';
import { getSurfaceChatContext } from '@client/app/utils/surfaceChatContext';

export const getSessionsFromServer = async (
  search: string = '',
  options: { pagination: { page: number; limit: number }; surface?: string; filters?: SessionListFilters } = {
    pagination: { page: 1, limit: 10 },
  }
) => {
  const response = await api.get<{ data: ISessionDocument[]; hasMore: boolean }>(`/api/sessions`, {
    params: {
      search,
      pagination: options.pagination,
      ...(options.surface ? { surface: options.surface } : {}),
      ...options.filters,
    },
  });

  return response.data;
};

export const getSharedSessionsFromServer = async (
  search: string = '',
  options: { pagination: { page: number; limit: number }; filters?: SessionListFilters } = {
    pagination: { page: 1, limit: 10 },
  }
) => {
  const response = await api.get<{ data: ISessionDocument[]; hasMore: boolean }>(`/api/sessions/shared`, {
    params: {
      query: search,
      pagination: options.pagination,
      ...options.filters,
    },
  });

  return response.data;
};

export const getChatMessages = async (
  sessionId: string,
  options?: {
    pagination?: { page: number; limit: number };
    all?: boolean;
    sort?: 'asc' | 'desc';
  }
) => {
  const response = await api.get<{ data: IChatHistoryItem[]; hasMore: boolean }>(`/api/sessions/${sessionId}/chat`, {
    params: options,
  });
  return response.data;
};

export const getSessionByIdFromServer = async (sessionId: string): Promise<ISessionDocument> => {
  const response = await api.get<ISessionDocument>(`/api/sessions/${sessionId}`);
  return response.data;
};

/**
 * The PUT /api/sessions/{id} body. `lakeScope` (tri-state: a list, `[]` for no lake, `null` to
 * clear) is the request-only spelling of the stored `retrievalTags`/`lakeScopeExplicit` pair, and
 * deliberately has no field of that name on `ISessionDocument` - a caller that spreads a whole
 * cached session into this payload (a rename PUTs the session back as-is) then has no `lakeScope`
 * key to accidentally carry, so the server's parse drops it rather than reading the echoed
 * `retrievalTags: []` Mongoose hydrates onto every session as a deliberate "ground on no lake".
 */
export type SessionUpdatePayload = Omit<Partial<ISessionDocument>, 'includeLibraryFiles'> &
  Pick<SessionUpdateRequest, 'lakeScope'> & { includeLibraryFilesChoice?: boolean };

// `includeLibraryFiles` is stripped because a whole-session echo (a rename) would otherwise resend a
// possibly stale cached value over a newer toggle. The client-only `includeLibraryFilesChoice` (no
// cached session carries it) is the one way to write the flag, so it can ride in the same PUT as
// the scope change that defaults it.
export const updateSessionToServer = async (sessionData: SessionUpdatePayload & { id: string }) => {
  const { includeLibraryFilesChoice, ...rest } = sessionData;
  // Omit only rejects a literal key: a spread cached session still carries it at runtime.
  const body: Record<string, unknown> = { ...rest };
  delete body.includeLibraryFiles;
  if (includeLibraryFilesChoice !== undefined) body.includeLibraryFiles = includeLibraryFilesChoice;
  const response = await api.put(`/api/sessions/${sessionData.id}`, body);
  return response.data;
};

/**
 * Map the current route path to a human-readable view description
 * for the LLM's navigate_view context awareness.
 */
function getViewDescription(): string | null {
  if (typeof window === 'undefined') return null;
  // A registered surface provider (e.g. a premium surface) wins over the
  // neutral route map below.
  const registered = getSurfaceChatContext().viewDescription;
  if (registered) return registered;
  const path = window.location.pathname;
  if (path.startsWith('/admin')) return 'User is on the Admin dashboard.';
  if (path.startsWith('/agents')) return 'User is on the Agents page.';
  if (path.startsWith('/projects')) return 'User is on the Projects page.';
  if (path.startsWith('/profile')) return 'User is on the Profile settings page.';
  if (path.startsWith('/knowledge')) return 'User is on the Knowledge Base page.';
  if (path.startsWith('/help')) return 'User is on the Help page.';
  if (path === '/') return 'User is on the main Chat page.';
  return null;
}

export const pushChatMessage = async (
  sessionId: string,
  message: IChatHistoryItem,
  experimentalFeatures?: {
    enableQuestMaster?: boolean;
    enableMementos: boolean;
    enableArtifacts: boolean;
    enableAgents: boolean;
    enableLattice: boolean;
  }
) => {
  // Inject current view context for navigate_view tool awareness, plus any
  // surface-registered active brief so "refine this" round-trips.
  const viewDesc = getViewDescription();
  const briefContext = getSurfaceChatContext().briefContext ?? null;
  const extraContextMessages = [
    ...(viewDesc
      ? [{ role: 'system' as const, content: `[Current View Context] ${viewDesc} Path: ${window.location.pathname}` }]
      : []),
    ...(briefContext ? [{ role: 'system' as const, content: briefContext }] : []),
  ];

  const response = await api.post(`/api/sessions/${sessionId}/chat`, {
    ...message,
    enableQuestMaster: experimentalFeatures?.enableQuestMaster,
    enableMementos: experimentalFeatures?.enableMementos,
    enableArtifacts: experimentalFeatures?.enableArtifacts,
    enableAgents: experimentalFeatures?.enableAgents,
    enableLattice: experimentalFeatures?.enableLattice,
    extraContextMessages,
  });
  return response.data;
};

export const deleteChatMessage = async (sessionId: string, messageId: string) => {
  const response = await api.delete(`/api/sessions/${sessionId}/chat/${messageId}`);
  return response.data;
};

export const stopChatMessage = async (sessionId: string) => {
  try {
    const response = await api.post(
      `/api/sessions/${sessionId}/chat/stop-reply`,
      { urgent: true },
      {
        headers: { 'X-Priority': 'high' },
        timeout: 5000, // Set a shorter timeout for cancellation requests
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error stopping chat message:', error);
    throw error;
  }
};

export const generateNewSession = async (
  name: string,
  knowledgeIds: string[] = [],
  agentIds: string[] = [],
  projectId?: string,
  lastUsedModel?: string
) => {
  const response = await api.post<ISessionDocument>(
    `/api/sessions/create`,
    { name, knowledgeIds, agentIds, projectId, lastUsedModel },
    { timeout: SEND_REQUEST_TIMEOUT_MS }
  );
  return response.data;
};

export const deleteSessionFromServer = async (sessionId: string): Promise<{ newLastNotebookId: string | null }> => {
  const response = await api.delete<{ newLastNotebookId: string | null }>(`/api/sessions/${sessionId}`);
  return response.data;
};

export const bulkDeleteSessionsFromServer = async (
  sessionIds: string[]
): Promise<{ deletedCount: number; newLastNotebookId: string | null }> => {
  const response = await api.delete<{ deletedCount: number; newLastNotebookId: string | null }>('/api/sessions/bulk', {
    data: { sessionIds },
  });
  return response.data;
};

export const generateSessionSummary = async (sessionId: string) => {
  const response = await api.post(`/api/sessions/${sessionId}/summary`);
  return response.data;
};

export const generateSessionTags = async (sessionId: string) => {
  const response = await api.post(`/api/sessions/${sessionId}/tag`);
  return response.data;
};

/** `targetSurface` omitted = the clone stays in the source's workspace; null = the main notebook list. */
export const cloneSession = async (sessionId: string, targetSurface?: string | null) => {
  const response = await api.post<ISessionDocument>(
    `/api/sessions/${sessionId}/clone`,
    targetSurface === undefined ? undefined : { targetSurface }
  );
  return response.data;
};

/** Moves a session the caller owns into another workspace (null = the main notebook list). */
export const moveSessionToSurface = async (sessionId: string, targetSurface: string | null) => {
  const response = await api.patch<ISessionDocument>(`/api/sessions/${sessionId}/surface`, { targetSurface });
  return response.data;
};

export const getChatMessage = async (sessionId: string, messageId: string): Promise<IChatHistoryItemDocument> => {
  const response = await api.get<IChatHistoryItemDocument>(`/api/sessions/${sessionId}/chat/${messageId}`);
  return response.data;
};

export const updateChatMessage = async (
  sessionId: string,
  messageId: string,
  // selectedChoiceIndex: the server owns the options, so a pick is sent as an index, never as suggestedChoices
  update: Partial<IChatHistoryItem> & { selectedChoiceIndex?: number }
) => {
  const response = await api.put(`/api/sessions/${sessionId}/chat/${messageId}`, update);
  return response.data;
};

export const checkQuestTimeout = async (questId: string): Promise<IChatHistoryItemDocument> => {
  const response = await api.post<IChatHistoryItemDocument>(`/api/quests/${questId}/check-timeout`);
  return response.data;
};

export const getFavoriteSessions = async (): Promise<ISessionFavoriteItem[]> => {
  const response = await api.get<ISessionFavoriteItem[]>(`/api/sessions/favorites`);

  return response.data;
};
