import type { IChatHistoryItem } from '@bike4mind/common';
import { useEffect, useRef } from 'react';
import {
  claimReplayDispatch,
  dispatchUiSideEffects,
  forgetSessionDispatches,
} from '@client/app/utils/uiSideEffectDispatcher';

type ReplayableQuest = Pick<IChatHistoryItem, 'id' | 'status' | 'uiSideEffects'>;

/**
 * Replay the newest loaded reply's uiSideEffects as the session's quests load. The
 * render-path dispatcher (PromptReplies) drops effects while pagination is loading, so
 * this scan covers that gap. Claims are shared with the render path, so a reply is
 * replayed once per view of its session.
 */
export function useLatestReplySideEffectReplay(sessionId: string, quests: readonly ReplayableQuest[]): void {
  const dispatchedQuestIds = useRef(new Set<string>());
  const pendingRelease = useRef<{ sessionId: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    // Leaving a session releases its replies so the next view replays them again. Deferred a
    // tick, because StrictMode's simulated unmount (same session remounting immediately)
    // must not release the view: that would replay every reply twice.
    if (pendingRelease.current?.sessionId === sessionId) {
      clearTimeout(pendingRelease.current.timer);
      pendingRelease.current = null;
    }
    dispatchedQuestIds.current.clear();
    return () => {
      const timer = setTimeout(() => {
        pendingRelease.current = null;
        forgetSessionDispatches(sessionId);
      }, 0);
      pendingRelease.current = { sessionId, timer };
    };
  }, [sessionId]);

  useEffect(() => {
    for (const quest of quests) {
      if (
        quest.id &&
        quest.status === 'done' &&
        quest.uiSideEffects &&
        quest.uiSideEffects.length > 0 &&
        !dispatchedQuestIds.current.has(quest.id)
      ) {
        dispatchedQuestIds.current.add(quest.id);
        // Replay (no `live`): this scans persisted quests, so handlers surface a review step
        // rather than auto-applying over state the user changed after the reply arrived.
        if (claimReplayDispatch(quest.id, sessionId)) dispatchUiSideEffects(quest.uiSideEffects);
        break; // Only dispatch the most recent one
      }
    }
  }, [quests, sessionId]);
}
