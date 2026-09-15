import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import {
  StreamedChatCompletionAction,
  IStreamedRapidReplyAction,
  IMessageDataToClient,
  IResearchModeStreamAction,
} from '@bike4mind/common';
import { useEffect, useState, useRef, useCallback } from 'react';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import perfLogger from '../utils/performanceLogger';
import { isOptimisticId } from '../utils/llm';
import { useStreamingState } from './useStreamingState';
import { useStreamingQueryUpdates } from './useStreamingQueryUpdates';
import { useStreamingMetrics } from './useStreamingMetrics';
import { useStreamingArtifactPersistence } from './useStreamingArtifactPersistence';
import { dispatchUiSideEffects } from '../utils/uiSideEffectDispatcher';

export type IChatCompletion = {
  completed: boolean;
  stopped: boolean;
  quest?: z.infer<typeof StreamedChatCompletionAction>['quest'];
  statusMessage?: string | null;
  rapidReply?: {
    content: string;
    status: 'streaming' | 'completed' | 'replaced';
    ttfvt?: number;
    modelId: string;
    mappingId: string;
  };
};

export function useSubscribeChatCompletion(sessionId: string | null) {
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();

  // Global streaming state for coordination with collection subscriptions
  const { startStreaming, receiveChunk, completeStreaming, errorStreaming } = useStreamingState();

  const [chatCompletion, setChatCompletion] = useState<IChatCompletion>({
    quest: undefined,
    completed: true,
    stopped: false,
    statusMessage: undefined,
    rapidReply: undefined,
  });

  // Track pending session to handle race conditions during session creation
  const pendingSessionRef = useRef<string | null>(null);

  // Last real (non-null, non-optimistic) sessionId this hook was subscribed to.
  // Used below to detect a switch between two different real sessions (e.g.
  // forking mid-stream) so a leftover "still streaming" state from the
  // previous session doesn't lock the newly-viewed session's composer.
  const prevRealSessionIdRef = useRef<string | null>(null);

  // Store the last processed quest to avoid duplicate/outdated processing
  const lastProcessedQuestRef = useRef<any | null>(null);

  // Store current chat completion state for access in callbacks
  const chatCompletionRef = useRef(chatCompletion);
  useEffect(() => {
    chatCompletionRef.current = chatCompletion;
  }, [chatCompletion]);

  // Extracted streaming concerns:
  // - query updates: batched React Query cache writes + optimistic-quest replacement
  // - metrics: throughput telemetry + client first-token timing
  // - artifacts: parse + persist artifacts from completed quests
  const { updateStreamingQuest, cleanupStream } = useStreamingQueryUpdates({ chatCompletionRef, setChatCompletion });
  const metrics = useStreamingMetrics();
  const artifactPersistence = useStreamingArtifactPersistence();

  // PERFORMANCE FIX: Stable message handler that doesn't depend on state
  const handleStreamingMessage = useCallback(
    async (msg: IMessageDataToClient | IResearchModeStreamAction) => {
      try {
        // PERFORMANCE PROTECTION: Mark as actively streaming + track chunk timing
        metrics.beginStreamingIfNeeded();
        metrics.recordMessage();

        // Check if this is a valid streamed_chat_completion, research_mode_stream, or streamed_rapid_reply message
        if (msg.action === 'research_mode_stream') {
          // TypeScript now knows this is a ResearchModeStreamAction
          const researchMessage = msg as IResearchModeStreamAction;

          // Handle Research Mode streaming update
          perfLogger.log(
            `🔬 [RESEARCH_MODE] Streaming update for config ${researchMessage.researchMode?.configurationId} (subscription ${metrics.subscriptionId})`
          );

          console.log('🔬 [useSubscribeChatCompletion] Research Mode stream message:', researchMessage);

          // Trigger a custom event for Research Mode streaming
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('research-mode-stream', {
                detail: {
                  questId: researchMessage.quest?.id,
                  configurationId: researchMessage.researchMode?.configurationId,
                  streamedTexts: researchMessage.researchMode?.streamedTexts,
                  completionInfo: researchMessage.researchMode?.completionInfo,
                },
              })
            );
          }
          return;
        }

        if ((msg as any).action === 'streamed_rapid_reply') {
          // TypeScript now knows this is a StreamedRapidReplyAction
          const rapidReplyMessage = msg as IStreamedRapidReplyAction;

          // Handle Rapid Reply streaming update
          perfLogger.log(
            `🚀 [RAPID_REPLY] Streaming update for quest ${rapidReplyMessage.questId} (subscription ${metrics.subscriptionId})`
          );

          console.log('🚀 [useSubscribeChatCompletion] Rapid Reply stream message:', rapidReplyMessage);

          // Update the rapid reply state
          setChatCompletion(prev => ({
            ...prev,
            rapidReply: rapidReplyMessage.rapidReply,
            statusMessage: rapidReplyMessage.statusMessage || prev.statusMessage,
          }));

          // Log rapid reply status changes for debugging
          perfLogger.log(
            `🚀 [RAPID_REPLY] Status: ${rapidReplyMessage.rapidReply.status}, Content length: ${rapidReplyMessage.rapidReply.content.length}`
          );

          // Trigger a custom event for Rapid Reply streaming
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('rapid-reply-stream', {
                detail: {
                  questId: rapidReplyMessage.questId,
                  sessionId: rapidReplyMessage.sessionId,
                  rapidReply: rapidReplyMessage.rapidReply,
                },
              })
            );
          }
          return;
        }

        if (msg.action !== 'streamed_chat_completion' || !('quest' in msg) || !msg.quest) {
          console.warn(`[QUEST-DROP] Invalid streaming message for subscription ${metrics.subscriptionId}`, {
            action: msg.action,
            hasQuest: 'quest' in msg,
          });
          return;
        }

        // TypeScript now knows this is a StreamedChatCompletionAction
        const typedMsg = msg as z.infer<typeof StreamedChatCompletionAction>;

        // Additional safety check (we already verified quest exists above, but TypeScript needs this)
        if (!typedMsg.quest) {
          console.warn(`[QUEST-DROP] Quest is null after type assertion`);
          return;
        }

        // PERFORMANCE BREAKTHROUGH: Optimize quest switching to prevent delays
        if (typedMsg.quest.id) {
          metrics.handleQuestTransition(typedMsg.quest.id);
        }

        // Allow messages for:
        // 1. The current session
        // 2. Any session when currentSessionId is null (new session being created)
        // 3. A pending session that was just created
        // 4. Any session while currentSessionId is still an optimistic tmp id
        //    (the realId migration via session.created may not have completed
        //    yet - chunks for the new session must not be silently dropped)
        const isValidSession =
          typedMsg.quest.sessionId === sessionId ||
          (!sessionId && typedMsg.quest.sessionId) ||
          typedMsg.quest.sessionId === pendingSessionRef.current ||
          (isOptimisticId(sessionId) && !!typedMsg.quest.sessionId);

        if (!isValidSession) {
          console.warn(`[QUEST-DROP] Wrong session for streaming chunk - subscription ${metrics.subscriptionId}`, {
            chunkSessionId: typedMsg.quest.sessionId,
            expectedSessionId: sessionId,
            pendingSessionId: pendingSessionRef.current,
            questId: typedMsg.quest.id,
          });
          return;
        }

        // If we receive a message for a new session, track it as pending
        if (!sessionId && typedMsg.quest.sessionId) {
          pendingSessionRef.current = typedMsg.quest.sessionId;
          perfLogger.log(
            `📝 [STREAMING] Tracking pending session ${typedMsg.quest.sessionId} (subscription ${metrics.subscriptionId})`
          );
        }

        // Clear pending session once we have a matching sessionId
        if (sessionId && sessionId === pendingSessionRef.current) {
          pendingSessionRef.current = null;
          perfLogger.log(`✅ [STREAMING] Pending session matched (subscription ${metrics.subscriptionId})`);
        }

        // STREAMING STATE COORDINATION: Update global streaming state for subscription coordination
        // This ensures useSubscribeToSessionQuests disables during active streaming
        const effectiveSessionId = typedMsg.quest.sessionId;
        if (effectiveSessionId) {
          if (metrics.isFirstChunk()) {
            // First message for this streaming session - mark as streaming
            startStreaming(effectiveSessionId, typedMsg.quest.id);
          } else {
            // Subsequent chunks - update last chunk time for timeout detection
            receiveChunk(effectiveSessionId);
          }
        }

        // CLIENT-SIDE PERFORMANCE TRACKING: Calculate time from prompt sent to first token rendered
        metrics.recordFirstTokenIfNeeded(typedMsg.quest);

        // PERFORMANCE BOOST: Use stream React Query updates to prevent main thread blocking
        const isComplete = typedMsg.quest.status === 'done';

        // Check if the incoming quest is outdated
        const lastProcessedQuest = lastProcessedQuestRef.current;
        let alreadyProcessed = false;
        if (lastProcessedQuest && lastProcessedQuest.id === typedMsg.quest.id) {
          const lastUpdatedAt = lastProcessedQuest.updatedAt ? new Date(lastProcessedQuest.updatedAt) : null;
          const incomingUpdatedAt = typedMsg.quest.updatedAt ? new Date(typedMsg.quest.updatedAt) : null;
          if (lastUpdatedAt && incomingUpdatedAt) {
            alreadyProcessed = incomingUpdatedAt < lastUpdatedAt;
          }
        }
        // Always process completion chunks even if updatedAt looks stale -
        // dropping the final chunk leaves the optimistic quest stuck.
        if (alreadyProcessed && !isComplete) {
          console.warn(
            `[QUEST-DROP] Ignoring outdated streaming chunk for quest ${typedMsg.quest.id} in subscription ${metrics.subscriptionId}`,
            {
              questId: typedMsg.quest.id,
              incomingUpdatedAt: typedMsg.quest.updatedAt,
              lastProcessedUpdatedAt: lastProcessedQuest?.updatedAt,
            }
          );
          return;
        } else {
          lastProcessedQuestRef.current = typedMsg.quest;
        }

        // When main response is complete, mark rapid reply as replaced
        // Only mark as replaced when the main response is actually finished, not when it starts
        const hasMainResponse = typedMsg.quest.replies && typedMsg.quest.replies.length > 0;
        const hasQuestMasterResponse = typedMsg.quest.questMasterPlanId || typedMsg.quest.questMasterReply;

        if (isComplete && (hasMainResponse || hasQuestMasterResponse) && chatCompletionRef.current.rapidReply) {
          const responseLength =
            hasMainResponse && typedMsg.quest.replies ? typedMsg.quest.replies.join('').length : 'QuestMaster';
          perfLogger.log(`🔄 [RAPID_REPLY] Clearing rapid reply - main response complete (${responseLength} chars)`);
          setChatCompletion(prev => ({
            ...prev,
            rapidReply: undefined, // Clear rapid reply completely when main response is done
          }));
        }

        updateStreamingQuest(typedMsg.quest, isComplete, typedMsg.statusMessage);

        // OPTIMIZED STREAMING: Real-time visual updates with performance optimizations
        if (isComplete) {
          // DIRECT DISPATCH: Dispatch uiSideEffects immediately on completion.
          // This bypasses the rendering pipeline (ChatHistory -> MessageContent -> PromptReplies ->
          // ReplyContainer -> UiSideEffectDispatcher) which has timing issues during the
          // streaming->completed transition. Direct dispatch is the reliable path.
          if (typedMsg.quest.uiSideEffects && typedMsg.quest.uiSideEffects.length > 0) {
            perfLogger.log(
              `🎯 [UI_SIDE_EFFECTS] Dispatching ${typedMsg.quest.uiSideEffects.length} side effect(s) from streaming completion`
            );
            // Live streaming completion - auto-apply the formulated brief and follow
            // the AI to its console. dedupeKey (quest id) makes this and the
            // render-pipeline dispatch apply the same quest exactly once.
            dispatchUiSideEffects(typedMsg.quest.uiSideEffects, { live: true, dedupeKey: typedMsg.quest.id });
          }

          // PERFORMANCE PROTECTION: Mark streaming as complete
          metrics.markStreamingComplete();

          // STREAMING STATE COORDINATION: Notify global state that streaming is done
          // This re-enables collection subscription for this session
          if (effectiveSessionId) {
            completeStreaming(effectiveSessionId);

            // Light the Agents toggle the instant a summoned agent lands.
            // An @mention makes the server attach the agent to `session.agentIds`
            // (AgentDetectionFeature), but nothing invalidates this query when the
            // response streams back, so the toggle only updates on the next refetch
            // (staleTime is 5 min, so even reopening the popover shows stale cache).
            // Use the quest's real `effectiveSessionId` so a brand-new notebook,
            // whose hook `sessionId` was still null at send time, is covered too.
            // On completion only, so it fires at most once per response.
            queryClient.invalidateQueries({
              queryKey: ['session-agents', effectiveSessionId],
            });

            // Force refetch quest data after streaming to ensure persisted cache
            // has the final 'done' status. Guards against stale IndexedDB snapshots
            // where the quest was persisted with status 'running' during streaming.
            const sessionIdToInvalidate = effectiveSessionId;
            setTimeout(() => {
              queryClient.invalidateQueries({
                queryKey: ['quests', 'session', sessionIdToInvalidate],
              });
              // Also refresh session files so any files a tool generated this turn
              // (images, Excel, etc. - persisted as FabFiles) appear in the Knowledge
              // Base without requiring a manual reload. The hook's 30-min staleTime
              // would otherwise hide them until navigation.
              queryClient.invalidateQueries({
                queryKey: ['fabFiles', 'own', { sessionId: sessionIdToInvalidate }],
              });
            }, 2000);
          }

          // ARTIFACT PERSISTENCE: Extract and save artifacts from completed quest
          // (parsing, dedup, persistence, and id broadcast are owned by the hook)
          artifactPersistence.persistArtifactsFromQuest(typedMsg.quest);
        }
      } catch (error) {
        perfLogger.error(`🚨 [STREAMING] Error in handleStreamingMessage:`, error);

        // STREAMING STATE COORDINATION: Mark session as errored if we have a valid session ID
        const errorSessionId = sessionId || pendingSessionRef.current;
        if (errorSessionId) {
          errorStreaming(errorSessionId);
        }
      }
    },
    [
      sessionId,
      updateStreamingQuest,
      metrics,
      artifactPersistence,
      startStreaming,
      receiveChunk,
      completeStreaming,
      errorStreaming,
      queryClient,
    ]
  ); // CRITICAL: Stable dependencies (extracted hooks are memoized; Zustand actions + queryClient are stable)

  // FIXED: Always call useEffect in the same order, no conditional logic
  useEffect(() => {
    // Clear per-session tracking when session changes (artifact dedup + client first-token timing)
    artifactPersistence.reset();
    metrics.reset();

    // Switching between two different real sessions (e.g. forking or navigating
    // away while a completion is in-flight) must not carry over the previous
    // session's "still streaming" state - otherwise the newly-viewed session's
    // composer shows a spurious Stop button until the OTHER session's stream
    // ends. Optimistic/null ids are skipped as endpoints of this comparison
    // since they're transient placeholders during session creation, not a
    // real session the user has switched away from or to.
    const isRealSessionId = (id: string | null): id is string => !!id && !isOptimisticId(id);
    if (isRealSessionId(sessionId)) {
      if (isRealSessionId(prevRealSessionIdRef.current) && prevRealSessionIdRef.current !== sessionId) {
        setChatCompletion({
          quest: undefined,
          completed: true,
          stopped: false,
          statusMessage: undefined,
          rapidReply: undefined,
        });
      }
      prevRealSessionIdRef.current = sessionId;
    }

    const unsubscribeChatCompletion = subscribeToAction('streamed_chat_completion', handleStreamingMessage);
    const unsubscribeRapidReply = subscribeToAction('streamed_rapid_reply', handleStreamingMessage);

    return () => {
      // Clear any pending stream updates
      cleanupStream();

      unsubscribeChatCompletion();
      unsubscribeRapidReply();
    };
  }, [subscribeToAction, sessionId, handleStreamingMessage, artifactPersistence, metrics, cleanupStream]);

  // STREAMING TIMEOUT RECOVERY: Monitor streaming state and reset if no chunks received
  // This prevents "stuck" streaming states that would permanently disable the collection subscription
  const { getStreamingInfo, resetStreaming, isStreamingSession } = useStreamingState();
  const isCurrentlyStreaming = sessionId ? isStreamingSession(sessionId) : false;

  useEffect(() => {
    // Only run interval when actively streaming - avoid unnecessary polling
    if (!sessionId || !isCurrentlyStreaming) return;

    const TIMEOUT_MS = 120000; // 120 seconds (longer than 90s server timeout)
    const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds

    const checkStreamingTimeout = () => {
      const streamingInfo = getStreamingInfo(sessionId);
      if (!streamingInfo || streamingInfo.status !== 'streaming') {
        return; // Not streaming, nothing to check
      }

      const now = Date.now();
      const timeSinceLastChunk = now - streamingInfo.lastChunkTime;

      if (timeSinceLastChunk >= TIMEOUT_MS) {
        perfLogger.log(`⏰ [STREAMING] Timeout detected for session ${sessionId}`, {
          timeSinceLastChunk,
          questId: streamingInfo.questId,
        });

        // Reset streaming state to re-enable collection subscription
        resetStreaming(sessionId);
      }
    };

    const intervalId = setInterval(checkStreamingTimeout, CHECK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [sessionId, isCurrentlyStreaming, getStreamingInfo, resetStreaming]);

  return { chatCompletion, setChatCompletion };
}
