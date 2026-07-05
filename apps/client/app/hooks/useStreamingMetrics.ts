import { useCallback, useMemo, useRef, useState } from 'react';
import perfLogger from '../utils/performanceLogger';
import { api } from '@client/app/contexts/ApiContext';

/**
 * useStreamingMetrics - owns streaming throughput telemetry + client first-token timing.
 *
 * Extracted from useSubscribeChatCompletion. Tracks message intervals, quest
 * transitions, and the prompt-sent -> first-token-rendered latency that is
 * reported back to the server. All counters are internal refs;
 * the hook exposes a small imperative surface plus the subscription id used in
 * the caller's log lines.
 */
export function useStreamingMetrics() {
  // Streaming performance telemetry.
  const [metricsSubId] = useState(() => Math.random().toString(36).slice(2, 11));
  const metricsRef = useRef({
    subscriptionId: metricsSubId,
    totalMessages: 0,
    lastMessageTime: 0,
    startTime: 0,
    intervals: [] as number[],
    questId: '',
    isActivelyStreaming: false,
  });

  // Track which quests have had their client first token time recorded to prevent duplicates
  const clientFirstTokenRecordedRef = useRef<Set<string>>(new Set());

  // Guard so the dev-only HMR dispose handler is registered at most once per hook
  // instance - the original registered a fresh closure on every stream cycle,
  // leaking one per stream in a long-lived dev session.
  const hmrDisposeRegisteredRef = useRef(false);

  // Enter active streaming mode on the first chunk. In development this also
  // suppresses hot-reload disposal so an edit mid-stream doesn't tear down the
  // subscription.
  const beginStreamingIfNeeded = useCallback(() => {
    const metrics = metricsRef.current;
    if (!metrics.isActivelyStreaming) {
      metrics.isActivelyStreaming = true;
      // startStreaming will be called after we have the quest.sessionId

      // Register the dispose handler once per hook instance (not per stream cycle)
      // so webpack's HMR dispose list doesn't accumulate a closure per stream.
      if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined' && !hmrDisposeRegisteredRef.current) {
        hmrDisposeRegisteredRef.current = true;
        // Temporarily disable hot reload during streaming
        (window as any).__webpack_require__?.hot?.dispose?.(() => {
          perfLogger.log(`⏸️ [STREAMING] Hot reload suppressed during streaming`);
        });
      }
    }
  }, []);

  // Record a received chunk's timing and increment the message counter.
  const recordMessage = useCallback(() => {
    const metrics = metricsRef.current;
    const now = Date.now();

    // Track message timing
    if (metrics.totalMessages === 0) {
      metrics.startTime = now;
    } else {
      const interval = now - metrics.lastMessageTime;
      metrics.intervals.push(interval);
    }

    metrics.totalMessages++;
    metrics.lastMessageTime = now;
  }, []);

  // Whether the current counter state represents the first chunk of a stream.
  // Read live (after recordMessage and any quest-transition reset) so the
  // caller can decide between startStreaming and receiveChunk.
  const isFirstChunk = useCallback(() => metricsRef.current.totalMessages === 1, []);

  // Reset interval/timing metrics when the streamed quest changes so a new
  // quest's averages aren't skewed by the previous one.
  const handleQuestTransition = useCallback((questId: string) => {
    const metrics = metricsRef.current;
    if (questId && metrics.questId !== questId) {
      if (metrics.questId) {
        perfLogger.log(
          `🔄 [STREAMING] Quest transition ${metrics.questId} → ${questId} (subscription ${metrics.subscriptionId})`
        );

        // Reset metrics for new quest to prevent average skewing
        metrics.intervals = [];
        metrics.startTime = Date.now();
        metrics.totalMessages = 1;
      }
      metrics.questId = questId;
    }
  }, []);

  // Calculate time from prompt sent to first token rendered, then report it back
  // to the server. Records once per quest; on failure the quest is un-marked so a
  // later chunk can retry.
  const recordFirstTokenIfNeeded = useCallback((quest: { id?: string; replies?: (string | null | undefined)[] }) => {
    const hasFirstToken = quest.replies && quest.replies.some(reply => reply && reply.trim().length > 0);
    if (hasFirstToken && quest.id && !clientFirstTokenRecordedRef.current.has(quest.id)) {
      const clientPromptSentTimeStr = sessionStorage.getItem(`quest-${quest.id}-sent-time`);
      if (clientPromptSentTimeStr) {
        const clientPromptSentTime = parseInt(clientPromptSentTimeStr, 10);
        const clientFirstTokenTime = Date.now() - clientPromptSentTime;

        // Mark this quest as having its client first token time recorded
        clientFirstTokenRecordedRef.current.add(quest.id);

        perfLogger.log(`⚡ [CLIENT_TIMING] Quest ${quest.id}: First token rendered in ${clientFirstTokenTime}ms`);

        // Send this metric back to the server
        api
          .post(`/api/quests/${quest.id}/client-timing`, {
            clientFirstTokenTime,
          })
          .catch((error: unknown) => {
            console.error('Failed to record client first token time:', error);
            // If failed, remove from recorded set so we can try again
            if (quest.id) {
              clientFirstTokenRecordedRef.current.delete(quest.id);
            }
          });

        // Clean up sessionStorage
        sessionStorage.removeItem(`quest-${quest.id}-sent-time`);
      }
    }
  }, []);

  // Mark streaming as complete.
  const markStreamingComplete = useCallback(() => {
    metricsRef.current.isActivelyStreaming = false;
  }, []);

  // Clear per-session tracking when the subscription's session changes.
  const reset = useCallback(() => {
    clientFirstTokenRecordedRef.current.clear();
  }, []);

  return useMemo(
    () => ({
      // Same value the ref was seeded with; read from state so we don't touch a
      // ref during render.
      subscriptionId: metricsSubId,
      beginStreamingIfNeeded,
      recordMessage,
      isFirstChunk,
      handleQuestTransition,
      recordFirstTokenIfNeeded,
      markStreamingComplete,
      reset,
    }),
    [
      metricsSubId,
      beginStreamingIfNeeded,
      recordMessage,
      isFirstChunk,
      handleQuestTransition,
      recordFirstTokenIfNeeded,
      markStreamingComplete,
      reset,
    ]
  );
}
