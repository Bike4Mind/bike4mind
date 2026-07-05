import { useUser } from '@client/app/contexts/UserContext';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { getFabFilesFromServerByIds } from '@client/app/utils/filesAPICalls';
import { pushChatMessage, updateSessionToServer } from '@client/app/utils/sessionsAPICalls';
import { getOrFetchSession } from '@client/app/hooks/data/sessions';
import { isOptimisticId } from '@client/app/utils/llm';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import { toast } from 'sonner';
import { IFabFileDocument, ISessionDocument, IChatHistoryItem, IAgent } from '@bike4mind/common';
import React, {
  Dispatch,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  FC,
  SetStateAction,
} from 'react';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { parseAgentMentions, findMatchingAgents } from '@client/app/utils/agentUtils';
import { api } from '@client/app/contexts/ApiContext';
import { dexie } from '../utils/dexie';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useSubscribeCollection, updateAllQueryData } from '../utils/react-query';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { setSessionLayout, clearRecentArtifacts } from '../hooks/useSessionLayout';
import { useSettingsFromServer } from '@client/app/hooks/data/settings';
import { useLLM } from './LLMContext';

export interface SessionsContextProps {
  changeSession: (sessionId: string) => Promise<void>;

  currentSession: ISessionDocument | null;
  setCurrentSession: Dispatch<SetStateAction<ISessionDocument | null>>;

  addMessageToSession: (message: IChatHistoryItem) => Promise<void>;

  sessionsMetaDataVersion: number;
  setSessionsMetaDataVersion: Dispatch<SetStateAction<number>>;

  saveSessionDataToFile: (session: ISessionDocument) => void;
  filesMetaDataVersion: number;
  setFilesMetaDataVersion: Dispatch<SetStateAction<number>>;

  /**
   * The selected session ID currently being viewed.
   */
  currentSessionId: string | null;
  setCurrentSessionId: Dispatch<SetStateAction<string | null>>;

  workBenchAgents: IAgent[];
  setWorkBenchAgents: Dispatch<SetStateAction<IAgent[]>>;
}

export const SessionsContext = createContext<SessionsContextProps | undefined>(undefined);

export const useSessions = () => {
  const context = useContext(SessionsContext);
  if (!context) {
    throw new Error(
      'useSessions must be used within a SessionsProvider. Wrap a parent component in <SessionsProvider> to fix this error.'
    );
  }
  return context;
};

export interface SessionsProviderProps {
  children: ReactNode;
}

interface SessionWorkBenchstate {
  workBenchFiles: IFabFileDocument[];
  fabFiles: IFabFileDocument[];
}

interface WorkBenchStore {
  sessionStates: Record<string, SessionWorkBenchstate>;

  // Actions
  initializeSession: (sessionId: string) => void;
  setWorkBenchFiles: (
    sessionId: string,
    files: IFabFileDocument[] | ((prev: IFabFileDocument[]) => IFabFileDocument[])
  ) => void;
  setFabFiles: (
    sessionId: string,
    files: IFabFileDocument[] | ((prev: IFabFileDocument[]) => IFabFileDocument[])
  ) => void;
  deleteFabFile: (sessionId: string, fileId: string) => void;
  clearAllSessions: () => void;

  // Selectors
  getWorkBenchFiles: (sessionId: string) => IFabFileDocument[];
  getFabFiles: (sessionId: string) => IFabFileDocument[];
}

const DEFAULT_SESSION_STATE: SessionWorkBenchstate = {
  workBenchFiles: [],
  fabFiles: [],
};

export const useWorkBenchStore = create<WorkBenchStore>((set, get) => ({
  sessionStates: {},

  initializeSession: (sessionId: string) => {
    const current = get().sessionStates[sessionId];
    if (!current) {
      set(state => ({
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: { ...DEFAULT_SESSION_STATE },
        },
      }));
    }
  },

  setWorkBenchFiles: (sessionId: string, filesOrUpdater) => {
    set(state => {
      const currentState = state.sessionStates[sessionId] || { ...DEFAULT_SESSION_STATE };
      const newFiles =
        'function' === typeof filesOrUpdater ? filesOrUpdater(currentState.workBenchFiles) : filesOrUpdater;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...currentState,
            workBenchFiles: newFiles,
          },
        },
      };
    });
  },

  setFabFiles: (sessionId: string, filesOrUpdater) => {
    set(state => {
      const currentState = state.sessionStates[sessionId] || { ...DEFAULT_SESSION_STATE };
      const newFiles = 'function' === typeof filesOrUpdater ? filesOrUpdater(currentState.fabFiles) : filesOrUpdater;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...currentState,
            fabFiles: newFiles,
          },
        },
      };
    });
  },

  deleteFabFile: (sessionId: string, fileId: string) => {
    set(state => {
      const currentState = state.sessionStates[sessionId];
      if (!currentState) return state;

      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...currentState,
            fabFiles: currentState.fabFiles.filter(f => f.id !== fileId),
          },
        },
      };
    });
  },

  clearAllSessions: () => {
    set({ sessionStates: {} });
  },

  getWorkBenchFiles: (sessionId: string) => {
    const state = get().sessionStates[sessionId];
    return state?.workBenchFiles || [];
  },

  getFabFiles: (sessionId: string) => {
    const state = get().sessionStates[sessionId];
    return state?.fabFiles || [];
  },
}));

const EMPTY_FILES: never[] = [];

export const useWorkBenchFiles = (sessionId?: string | null) => {
  return useWorkBenchStore(useShallow(state => state.sessionStates[sessionId ?? '']?.workBenchFiles || EMPTY_FILES));
};

export const useFabFiles = (sessionId: string | null) => {
  return useWorkBenchStore(useShallow(state => state.sessionStates[sessionId ?? '']?.fabFiles || EMPTY_FILES));
};

export const useWorkBenchActions = () => {
  return useWorkBenchStore(
    useShallow(state => ({
      initializeSession: state.initializeSession,
      setWorkBenchFiles: state.setWorkBenchFiles,
      setFabFiles: state.setFabFiles,
      deleteFabFile: state.deleteFabFile,
      clearAllSessions: state.clearAllSessions,
    }))
  );
};

export const useSystemPromptFiles = () => {
  const { currentUser } = useUser();
  const { data: serverSettings } = useSettingsFromServer();

  // Get global system file IDs from admin settings
  const globalSystemFileIds = useMemo(() => {
    const systemFilesSettings = serverSettings?.find((s: any) => s.settingName === 'SystemFiles');
    if (!systemFilesSettings?.settingValue) return [];

    return systemFilesSettings.settingValue
      .split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
  }, [serverSettings]);

  // Get user system file IDs
  const userSystemFileIds = useMemo(() => {
    if (!currentUser?.systemFiles) return [];
    return currentUser.systemFiles.filter(file => file.enabled).map(file => file.fileId);
  }, [currentUser]);

  // Combine and deduplicate
  const allSystemFileIds = useMemo(() => {
    return Array.from(new Set([...globalSystemFileIds, ...userSystemFileIds]));
  }, [globalSystemFileIds, userSystemFileIds]);

  const { data: systemFiles = [], isLoading } = useQuery({
    queryKey: ['system-prompt-files', allSystemFileIds],
    queryFn: async () => {
      if (allSystemFileIds.length === 0) return [];

      try {
        // Fetch files individually to handle 404s gracefully
        const filePromises = allSystemFileIds.map(async id => {
          try {
            const response = await api.get<IFabFileDocument>(`/api/files/${id}`);
            return response.data;
          } catch (error: any) {
            if (error?.response?.status === 404) {
              console.warn(`❌ System prompt file ${id} not found (404) - will be ignored`);
              return null;
            }
            throw error;
          }
        });

        const results = await Promise.allSettled(filePromises);
        const validFiles = results
          .filter(
            (result): result is PromiseFulfilledResult<IFabFileDocument | null> =>
              result.status === 'fulfilled' && result.value !== null
          )
          .map(result => result.value as IFabFileDocument);

        const failedCount = allSystemFileIds.length - validFiles.length;
        if (failedCount > 0) {
          console.warn(`⚠️ ${failedCount} system prompt files could not be found and will be ignored`);
        }

        return validFiles;
      } catch (error) {
        console.error('Failed to fetch system prompt files:', error);
        return [];
      }
    },
    enabled: allSystemFileIds.length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  return {
    systemFiles: systemFiles || [],
    isLoading,
    globalSystemFileIds,
    userSystemFileIds,
  };
};

export const useSessionAgents = (sessionId?: string) => {
};

export const SessionsProvider: FC<SessionsProviderProps> = ({ children }) => {
  const { currentUser } = useUser.getState();

  // The current session ID, many components use this to determine if they should render
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // The current session, with all the data
  const [currentSession, setCurrentSession] = useState<ISessionDocument | null>(null);
  const [sessionsMetaDataVersion, setSessionsMetaDataVersion] = useState<number>(0);
  const [filesMetaDataVersion, setFilesMetaDataVersion] = useState<number>(0);

  const [workBenchAgents, setWorkBenchAgents] = useState<IAgent[]>([]);
  const { initializeSession, setWorkBenchFiles } = useWorkBenchActions();

  // Auto-disable expensive tools when switching notebooks
  const { setLLM, tools, isQuestMasterEnabled } = useLLM(
    useShallow(s => ({ setLLM: s.setLLM, tools: s.tools, isQuestMasterEnabled: s.isQuestMasterEnabled }))
  );
  const previousSessionIdRef = useRef<string | null>(null);

  const { data: paginatedFabFiles } = useGetFabFiles();
  const fabFiles = useMemo(() => paginatedFabFiles?.pages?.map(page => page.data).flat(), [paginatedFabFiles?.pages]);
  const queryClient = useQueryClient();

  // Memoize the query object to prevent re-subscription churn: this is an
  // always-mounted context, so an unstable inline query churns the websocket subscription.
  const fabfilesQuery = useMemo(() => ({ isChunk: false }), []);
  useSubscribeCollection<IFabFileDocument>('fabfiles', fabfilesQuery, undefined, {
    fetchInitialData: false,
  });

  const { settings } = useUserSettings();
  const { isFeatureEnabled } = useFeatureEnabled();
  const { data: availableAgents = [] } = useGetAgents();

  const addMessageToSession = useCallback(
    async (message: IChatHistoryItem) => {
      try {
        if (!message?.sessionId) {
          throw new Error('Session or message not found');
        }

        // Detect agent mentions in the message
        const mentionedWords = parseAgentMentions(message.prompt);
        const attachedAgentIds: string[] = [];

        if (mentionedWords.length > 0 && availableAgents.length > 0) {
          // Find agents that match the mentions
          const matchingAgents = findMatchingAgents(mentionedWords, availableAgents);

          if (matchingAgents.length > 0) {
            console.log(`🤖 Detected agent mentions: ${mentionedWords.join(', ')}`);
            console.log(`🤖 Matching agents: ${matchingAgents.map(a => a.name).join(', ')}`);

            // Attach agents to the session
            for (const agent of matchingAgents) {
              try {
                await api.post(`/api/sessions/${message.sessionId}/agents`, { agentId: agent.id });
                attachedAgentIds.push(agent.id);
                console.log(`🤖 Attached agent ${agent.name} to session`);
              } catch (error) {
                console.error(`Failed to attach agent ${agent.name}:`, error);
              }
            }

            // Update the current session state to include the new agents
            if (currentSession && attachedAgentIds.length > 0) {
              const updatedAgentIds = [...(currentSession.agentIds || []), ...attachedAgentIds];
              const uniqueAgentIds = Array.from(new Set(updatedAgentIds));
              setCurrentSession(prev => (prev ? { ...prev, agentIds: uniqueAgentIds } : null));
            }
          }
        }

        // Add agent IDs to the message
        const messageWithAgents = {
          ...message,
          agentIds: attachedAgentIds.length > 0 ? attachedAgentIds : undefined,
        };

        const optimisticTimestamp = message.timestamp ? new Date(message.timestamp) : new Date();
        const optimisticSessionUpdate = {
          id: message.sessionId,
          lastUpdated: optimisticTimestamp,
          updatedAt: optimisticTimestamp,
        } as Partial<ISessionDocument> & { id: string };

        setCurrentSession(prev =>
          prev && prev.id === message.sessionId
            ? {
                ...prev,
                lastUpdated: optimisticTimestamp,
                updatedAt: optimisticTimestamp,
              }
            : prev
        );

        updateAllQueryData(queryClient, 'sessions', 'write', optimisticSessionUpdate);

        queryClient.setQueryData<ISessionDocument | undefined>(['sessions', message.sessionId], prev =>
          prev
            ? {
                ...prev,
                lastUpdated: optimisticTimestamp,
                updatedAt: optimisticTimestamp,
              }
            : prev
        );

        await pushChatMessage(message.sessionId.toString(), messageWithAgents, {
          ...settings.experimentalFeatures,
          // Override the two graduating features the chat API consumes so users relying on
          // admin defaults (never explicitly set) get the correct feature state.
          enableArtifacts: isFeatureEnabled('enableArtifacts'),
          enableAgents: isFeatureEnabled('enableAgents'),
        });

        // Force immediate UI update by invalidating quest cache
        queryClient.invalidateQueries({ queryKey: ['quests', 'session', message.sessionId] });
      } catch (error) {
        console.error('Error adding message to session:', error);
      }
    },
    [settings.experimentalFeatures, isFeatureEnabled, availableAgents, currentSession, queryClient]
  );

  // Utility function to fetch files, first trying local storage, then the server
  const fetchFiles = useCallback(
    async (knowledgeIds: string[]): Promise<IFabFileDocument[]> => {
      const safeFabFiles = fabFiles ?? [];

      const localFiles = knowledgeIds
        .map(knowledgeId => safeFabFiles.find(file => file.id === knowledgeId))
        .filter(file => file !== undefined) as IFabFileDocument[];

      const filesToFetch = knowledgeIds.filter(id => !localFiles.some(file => file.id === id));

      if (filesToFetch.length < 1) {
        return localFiles;
      }

      const fetchedFilesResults = await getFabFilesFromServerByIds(filesToFetch);

      setFilesMetaDataVersion(prevVersion => prevVersion + 1);

      return [...localFiles, ...fetchedFilesResults].map(file => ({ ...file, enabled: true }));
    },
    [fabFiles]
  );

  // Persist session knowledgeIds to the backend
  const persistSessionKnowledgeIds = useCallback(async (sessionId: string, knowledgeIds: string[]) => {
    try {
      await updateSessionToServer({
        id: sessionId,
        knowledgeIds: knowledgeIds,
      });
    } catch {
      // Don't throw - this is a background operation
      // Silent failure to avoid console noise
    }
  }, []);

  const saveSessionDataToFile = useCallback(async (session: ISessionDocument) => {
    const quests = await dexie.quests.where('sessionId').equals(session.id).toArray();
    const title = formatSessionTitle(session.name);
    let dataString = title + '\n\n';
    quests.forEach((quest: IChatHistoryItem) => {
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
  }, []);

  // Enhanced setCurrentSession that automatically persists knowledgeIds
  const setCurrentSessionWithPersistence = useCallback(
    (session: ISessionDocument | null | ((prev: ISessionDocument | null) => ISessionDocument | null)) => {
      if (typeof session === 'function') {
        setCurrentSession(prev => {
          const newSession = session(prev);

          // If knowledgeIds changed, persist them
          if (
            newSession &&
            prev &&
            JSON.stringify(newSession.knowledgeIds || []) !== JSON.stringify(prev.knowledgeIds || [])
          ) {
            // Persist in background (don't await to avoid blocking UI)
            persistSessionKnowledgeIds(newSession.id, newSession.knowledgeIds || []);
          }

          return newSession;
        });
      } else {
        // Direct session object or null
        setCurrentSession(prev => {
          // If knowledgeIds changed, persist them
          if (
            session &&
            prev &&
            JSON.stringify(session.knowledgeIds || []) !== JSON.stringify(prev.knowledgeIds || [])
          ) {
            // Persist in background (don't await to avoid blocking UI)
            persistSessionKnowledgeIds(session.id, session.knowledgeIds || []);
          }

          return session;
        });
      }
    },
    [persistSessionKnowledgeIds]
  );

  const changeSession = useCallback(
    async (sessionId: string) => {
      // Early exit if already on this session
      if (sessionId === currentSessionId) return;
      if (!currentUser?.id) return;

      // Optimistic session IDs are seeded into the cache and into context by
      // useSendMessage before navigation. The server doesn't know about them
      // (they're client-generated UUIDs), so hitting GET /api/sessions/<tmpId>
      // would 404 and surface a misleading "Failed to open session" toast.
      // The session.created WS handler will swap in the real id shortly.
      if (isOptimisticId(sessionId)) return;

      // Clear recent artifacts when switching conversations
      clearRecentArtifacts();

      let session;
      try {
        session = await getOrFetchSession(queryClient, sessionId);
      } catch (err) {
        console.error('Failed to open session:', err);
        toast.error('Failed to open session');
        return;
      }

      // Clear the previous session's workbench files AND agents BEFORE switching
      if (currentSessionId) {
        setWorkBenchFiles(currentSessionId, []);
      }

      setWorkBenchAgents([]);

      setSessionLayout({ selectedArtifactId: undefined, artifactData: undefined });
      // Fetch and set the new session
      setCurrentSession(session);
      setCurrentSessionId(sessionId);

      // Initialize the new session immediately
      initializeSession(sessionId);

      // Session switch completed - files will be restored via useEffect

      // Update the user's last notebook ID if it's a different session
      if (sessionId && currentUser.lastNotebookId !== sessionId) {
        updateUserToServer(currentUser.id, { lastNotebookId: sessionId });
        queryClient.invalidateQueries({ queryKey: ['sessions', sessionId] });
      }
    },
    [currentSessionId, currentUser?.id, queryClient, currentUser?.lastNotebookId, setWorkBenchFiles, initializeSession]
  );

  // Usage in useEffect for initial fetch
  useEffect(() => {
    if (currentSession?.knowledgeIds?.length && currentSessionId) {
      fetchFiles(currentSession.knowledgeIds)
        .then(fetched => setWorkBenchFiles(currentSessionId, fetched))
        .catch(console.error);
    } else if (currentSessionId) {
      setWorkBenchFiles(currentSessionId, []);
    }
  }, [currentSession?.knowledgeIds, fabFiles, fetchFiles, currentSessionId, setWorkBenchFiles]);

  // AUTO-DISABLE EXPENSIVE TOOLS: Disable Deep Research and QuestMaster when SWITCHING notebooks (A->B)
  // This prevents accidental expensive operations when users change context
  // Note: We do NOT auto-disable when CREATING a new session (null->A), as the user may have
  // explicitly enabled these tools (e.g., New Quest from /quests page)
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current;

    // Only disable if we actually switched sessions (not on initial load or new session creation)
    // Skip if the session ID hasn't changed
    // Skip if previousSessionId is null - this is a NEW session, not a switch
    if (previousSessionId === currentSessionId || previousSessionId === null) {
      // Update the ref for next time but don't disable tools
      previousSessionIdRef.current = currentSessionId;
      return;
    }

    // This is a real session switch - check if we need to disable tools
    const hasDeepResearch = tools.includes('deep_research');
    const hasQuestMaster = isQuestMasterEnabled;

    if (hasDeepResearch || hasQuestMaster) {
      console.log('🔒 Auto-disabling expensive tools due to notebook switch', {
        from: previousSessionId,
        to: currentSessionId,
        disablingDeepResearch: hasDeepResearch,
        disablingQuestMaster: hasQuestMaster,
      });

      // Create updated tools array without deep_research
      const updatedTools = hasDeepResearch ? tools.filter(tool => tool !== 'deep_research') : tools;

      // Update LLM state
      setLLM({
        tools: updatedTools,
        isQuestMasterEnabled: false, // Always disable QuestMaster on session switch
      });

      // Show user notification if any tools were disabled
      setTimeout(() => {
        if (typeof window !== 'undefined') {
          const disabledTools = [];
          if (hasDeepResearch) disabledTools.push('Deep Research');
          if (hasQuestMaster) disabledTools.push('QuestMaster');

          const event = new CustomEvent('show-toast', {
            detail: {
              message: `${disabledTools.join(' and ')} disabled when switching notebooks. Re-enable in tools if needed.`,
              type: 'info',
            },
          });
          window.dispatchEvent(event);
        }
      }, 1000);
    }

    // Update the ref to track this session ID for the next change
    previousSessionIdRef.current = currentSessionId;
  }, [currentSessionId, tools, isQuestMasterEnabled, setLLM]); // Include dependencies but logic prevents unnecessary disabling

  // Initialize sessions
  useEffect(() => {
    if (currentSessionId) {
      initializeSession(currentSessionId);
    }
  }, [currentSessionId, initializeSession]);

  // Memoize the context value to prevent unnecessary re-renders of the context consumers
  const contextValue = useMemo(
    () => ({
      changeSession,
      currentSession,
      setCurrentSession: setCurrentSessionWithPersistence, // Use enhanced version
      addMessageToSession,
      currentSessionId,
      setCurrentSessionId,
      workBenchAgents,
      setWorkBenchAgents,
      sessionsMetaDataVersion,
      setSessionsMetaDataVersion,
      filesMetaDataVersion,
      setFilesMetaDataVersion,
      saveSessionDataToFile,
    }),
    [
      changeSession,
      currentSession,
      addMessageToSession,
      currentSessionId,
      workBenchAgents,
      sessionsMetaDataVersion,
      filesMetaDataVersion,
      saveSessionDataToFile,
      setCurrentSessionWithPersistence,
    ]
  );

  return <SessionsContext.Provider value={contextValue}>{children}</SessionsContext.Provider>;
};

export default SessionsProvider;
