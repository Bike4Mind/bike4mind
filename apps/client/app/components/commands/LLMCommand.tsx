import { api } from '@client/app/contexts/ApiContext';
import { WebsocketContextValue } from '@client/app/contexts/WebsocketContext';
import { createOptimisticQuest, updateOptimisticQuest } from '@client/app/utils/llm';
import {
  B4MLLMTools,
  GenerateImageToolCall,
  IChatHistoryItem,
  IChatHistoryItemDocument,
  IFabFileDocument,
  IMessage,
  ISessionDocument,
  LLMApiRequestBody,
  ModelName,
} from '@bike4mind/common';
import { AxiosResponse, isAxiosError } from 'axios';
import i18n from 'i18next';
import { toast } from 'sonner';
import { QueryClient } from '@tanstack/react-query';
import perfLogger from '../../utils/performanceLogger';
import { CommandArgExtra } from '@client/app/utils/commands';
import { classifyQueryComplexity } from '@bike4mind/common';
import { createOptimisticSessionId } from '@client/app/utils/llm';
import { getSurfaceChatContext } from '@client/app/utils/surfaceChatContext';

export type LLMCommandArgs = {
  params: string;
  currentSession: ISessionDocument | null;
  model: ModelName;
  workBenchFiles: IFabFileDocument[];
  sendJsonMessage?: WebsocketContextValue['sendJsonMessage'];
  promptFileIds: string[];
  dashboardParams?: LLMApiRequestBody['dashboardParams'];
  questId?: string;
  enableQuestMaster?: boolean;
  enableMementos?: boolean;
  enableArtifacts?: boolean;
  enableAgents?: boolean;
  enableLattice?: boolean;
  queryClient: QueryClient;
  tools: B4MLLMTools[];
  projectId?: string;
  organizationId?: string | null;
  questMaster?: LLMApiRequestBody['questMaster'];
  researchMode?: LLMApiRequestBody['researchMode'];
  imageConfig?: GenerateImageToolCall;
  deepResearchConfig?: {
    maxDepth?: number;
    duration?: number;
  };
  setChatCompletion?: (updater: (prev: any) => any) => void;
  mcpServers?: string[];
  optimisticSessionId?: string;
  /** Agent-mode toggle state forwarded through to the chat completion payload. */
  agentMode?: LLMApiRequestBody['agentMode'];
} & LLMSettings;

export type LLMSettings = {
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[] | null;
  max_tokens: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: { [key: string]: number };
  thinking?: {
    enabled: boolean;
    budget_tokens?: number;
  };
};

type ParsedSpec = {
  historyCount: number;
  userPrompt: string;
};

// `[Context:fileName]` markers are still PREPENDED by `extractCommandAndParams` (commands.ts) when
// `liveAI` is on, but `fabFileIds` is now sourced from `workBenchFiles` directly, so we no longer
// extract the captured filenames - we just strip the markers out of the user-visible prompt.
const CONTEXT_MARKER_REGEX = /\[Context:[^\]]+\]/g;
const HISTORY_MARKER_REGEX = /\[History:(\d+)\]/;

export const parseLLMSpec = (llmSpec: string): ParsedSpec => {
  let historyCount = 1;

  const historyMatch = HISTORY_MARKER_REGEX.exec(llmSpec);
  if (historyMatch) {
    historyCount = parseInt(historyMatch[1], 10);
  }

  const userPrompt = llmSpec.replace(CONTEXT_MARKER_REGEX, '').replace(HISTORY_MARKER_REGEX, '').trim();

  return { historyCount, userPrompt };
};

export async function handleLLMCommand(
  args: LLMCommandArgs & Pick<CommandArgExtra, 'userId' | 'modelConfigurations'>
): Promise<{ session: ISessionDocument; quest: IChatHistoryItemDocument } | undefined> {
  try {
    const {
      params,
      workBenchFiles,
      currentSession,
      model,
      dashboardParams,
      promptFileIds,
      questId,
      enableQuestMaster,
      queryClient,
      tools,
      projectId,
      organizationId,
      max_tokens = 2048,
      enableAgents,
      questMaster,
      researchMode,
      imageConfig,
      deepResearchConfig,
      mcpServers,
      optimisticSessionId,
      agentMode,
    } = args;

    perfLogger.log('tools', tools);
    perfLogger.log('enableAgents', enableAgents);

    const { historyCount, userPrompt } = parseLLMSpec(params);

    const userPromptArray: IMessage[] = [];
    userPromptArray.push({ role: 'user', content: userPrompt });

    // Include every workbench file: filtering by `[Context:fileName]` markers misses files
    // when `liveAI` is off (no markers prepended) and when filenames contain characters that
    // don't round-trip through the marker syntax. Matches the agent_execute path's pattern.
    const fabFileIds = workBenchFiles.map(file => file.id);

    const tmpSessionId = optimisticSessionId || createOptimisticSessionId();

    const optimisticOperation = questId
      ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
          updateOptimisticQuest(
            queryClient,
            questId,
            currentSession?.id,
            { replies: [], reply: undefined, prompt: userPrompt, timestamp: new Date(), status: undefined },
            cb
          )
      : currentSession?.id || tmpSessionId
        ? (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) =>
            createOptimisticQuest(queryClient, currentSession?.id || tmpSessionId, userPrompt, cb)
        : async (cb: () => Promise<{ quest: IChatHistoryItemDocument; session: ISessionDocument }>) => {
            // For new sessions: call API first, then optimistically update cache with response
            const result = await cb();

            return result;
          };

    // Don't send objects not intended for the API request
    const {
      currentSession: _currentSession,
      mcpServers: _omitMcpServers,
      modelConfigurations: _omitModelConfigurations,
      deepResearchConfig: _omitDeepResearchConfig,
      researchMode: _omitResearchMode,
      imageConfig: _omitImageConfig,
      agentMode: _omitAgentMode,
      ...payload
    } = args;

    const response = await optimisticOperation(async () => {
      // Get user's browser timezone for date/time context
      const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Build view context for navigate_view tool awareness
      const viewContextMessages: LLMApiRequestBody['extraContextMessages'] = (() => {
        if (typeof window === 'undefined') return undefined;
        const path = window.location.pathname;
        const descriptions: Record<string, string> = {
          '/admin': 'User is on the Admin dashboard.',
          '/agents': 'User is on the Agents page.',
          '/projects': 'User is on the Projects page.',
          '/profile': 'User is on the Profile settings page.',
          '/knowledge': 'User is on the Knowledge Base page.',
          '/help': 'User is on the Help page.',
        };
        const surfaceCtx = getSurfaceChatContext();
        const desc =
          surfaceCtx.viewDescription ||
          Object.entries(descriptions).find(([prefix]) => path.startsWith(prefix))?.[1] ||
          (path === '/' ? 'User is on the main Chat page.' : null);
        const messages: NonNullable<LLMApiRequestBody['extraContextMessages']> = [];
        if (desc) messages.push({ role: 'system' as const, content: `[Current View Context] ${desc} Path: ${path}` });
        // A surface-registered active brief (e.g. the optimization brief) makes
        // "refine this" target the current brief. This is the path interactive
        // chat actually uses - pushChatMessage is REST-only.
        const briefContext = surfaceCtx.briefContext ?? null;
        if (briefContext) messages.push({ role: 'system' as const, content: briefContext });
        return messages.length > 0 ? messages : undefined;
      })();

      // Track client-side timing: the moment the prompt is submitted from the
      // client. Captured before the payload so it can ride along to the backend
      // for the request-lifecycle status log (and reused for rapid-reply below).
      const clientPromptSentTime = Date.now();

      const requestPayload: LLMApiRequestBody = {
        questId,
        sessionId: currentSession?.id,
        historyCount,
        clientSubmittedAt: clientPromptSentTime,
        fabFileIds,
        message: userPrompt,
        messageFileIds: promptFileIds,
        enableQuestMaster,
        enableMementos: args.enableMementos,
        enableArtifacts: args.enableArtifacts,
        enableAgents: args.enableAgents,
        enableLattice: args.enableLattice,
        ...(dashboardParams ? { dashboardParams } : {}),
        params: {
          ...payload,
          model,
          max_tokens,
        },
        tools,
        projectId,
        organizationId,
        ...(questMaster ? { questMaster } : {}),
        ...(researchMode ? { researchMode } : {}),
        // Include mcpServers if it's an array (even empty - means user disabled all)
        ...(Array.isArray(mcpServers) ? { mcpServers } : {}),
        ...(deepResearchConfig ? { deepResearchConfig } : {}),
        ...(imageConfig ? { imageConfig } : {}),
        ...(agentMode ? { agentMode } : {}),
        // Send user's browser timezone for localized date/time context
        timezone: userTimezone,
        // Send current view context for navigate_view tool awareness
        ...(viewContextMessages ? { extraContextMessages: viewContextMessages } : {}),
      };

      // RAPID REPLY: fire immediately (client-side, non-blocking)
      // Determine query complexity client-side
      const queryComplexity = classifyQueryComplexity(
        userPrompt,
        fabFileIds,
        workBenchFiles.map(file => file.id),
        tools,
        researchMode,
        currentSession?.agentIds ? currentSession.agentIds : []
      );

      // Sessions on the opti surface always get the instant ack (their KB-search
      // round-trips make the wait long regardless of classified complexity). The
      // endpoint scopes enablement to that surface.
      const isOptiSession =
        currentSession?.surface === 'opti' ||
        (typeof window !== 'undefined' && window.location.pathname.startsWith('/opti'));

      // Fire rapid reply if it's an opti-surface session, complex, or has files. `fabFileIds`
      // is built from `workBenchFiles`, so the workbench check covers the file case.
      if (isOptiSession || queryComplexity === 'complex' || workBenchFiles.length > 0) {
        perfLogger.log(
          `🚀 [RapidReply] Firing rapid reply request (complexity: ${queryComplexity}, opti: ${isOptiSession}, questId: ${questId || 'none'})`
        );

        // Fire and forget - don't await, catch errors silently
        // Server will skip gracefully if questId is missing (new quests)
        api
          .post('/api/ai/rapid-reply', {
            questId: questId,
            sessionId: currentSession?.id,
            message: userPrompt,
            model: model,
            userId: args.userId,
            fabFileIds,
            messageFileIds: promptFileIds,
            processStartTime: clientPromptSentTime,
            isOpti: isOptiSession,
          })
          .catch(err => {
            perfLogger.log(`🚀 [RapidReply] Fire-and-forget failed (non-blocking): ${err.message}`);
            // Don't throw - rapid reply failures shouldn't break main flow
          });
      } else {
        perfLogger.log(`🚀 [RapidReply] Skipped (complexity: ${queryComplexity}, no files)`);
      }

      const { data } = await api.post<
        IChatHistoryItem,
        AxiosResponse<{
          session: ISessionDocument;
          quest: IChatHistoryItemDocument;
        }>,
        LLMApiRequestBody
      >('/api/ai/llm', requestPayload);

      // Store the sent time in the quest data for later calculation
      if (data && data.quest.id) {
        // Store in sessionStorage for quick access (keyed by quest ID)
        sessionStorage.setItem(`quest-${data.quest.id}-sent-time`, clientPromptSentTime.toString());
        perfLogger.log(`⏱️ [CLIENT] Prompt sent at ${clientPromptSentTime} for quest ${data.quest.id}`);
      }

      return data;
    });

    return response;
  } catch (error: unknown) {
    console.error('Error sending LLM command', error);

    // Show user-friendly error messages based on error type
    if (isAxiosError(error)) {
      const status = error.response?.status;
      const message = error.response?.data?.message || error.message;

      if (status === 404) {
        toast.error(i18n.t('session.errors.notebookDeleted'));
      } else if (status === 401 || status === 403) {
        toast.error(i18n.t('session.errors.noPermission'));
      } else if (status === 400) {
        toast.error(i18n.t('session.errors.invalidRequest'));
      } else if (status === 429) {
        toast.error(i18n.t('session.errors.tooManyRequests'));
      } else if (status && status >= 500) {
        toast.error(i18n.t('session.errors.serverError'));
      } else {
        // Log technical details for debugging, show generic message to user
        console.error('Unexpected error details:', message);
        toast.error(i18n.t('session.errors.sendFailed'));
      }
    } else {
      // Network error or non-Axios error
      toast.error(i18n.t('session.errors.networkError'));
    }

    // Re-throw so caller knows it failed
    throw error;
  }
}
