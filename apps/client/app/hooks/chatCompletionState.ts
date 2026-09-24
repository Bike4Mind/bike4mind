import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { isOptimisticId } from '../utils/llm';
import type { IChatCompletion } from './useSubscribeChatCompletion';

/**
 * Pure transitions for the composer's chat-completion state, kept out of the hooks
 * (useSubscribeChatCompletion, useSendMessage, SessionBottom) so the rules that decide
 * whether Stop shows can be unit tested without a websocket.
 */

export const IDLE_CHAT_COMPLETION: IChatCompletion = {
  quest: undefined,
  completed: true,
  stopped: false,
  statusMessage: undefined,
  rapidReply: undefined,
};

/** True for any status that ends a quest (done, stopped, or any later addition). */
export function isTerminalQuestStatus(status: string | null | undefined): boolean {
  return !!status && status !== 'running';
}

const isCreatingSession = (sessionId: string | null) => !sessionId || isOptimisticId(sessionId);

/**
 * Whether a streamed frame belongs to the viewed session. While the session id is still
 * null/optimistic the frame carries a session id the tab doesn't know yet, so only the
 * quest this tab just sent is accepted: the one already held, or the first frame to land
 * while the tab's own send is awaiting it.
 *
 * `mintingOwnSession` is that same "awaiting" signal when the held state can't carry it:
 * the /new -> /notebooks/<optimistic id> navigation remounts the chat-completion provider,
 * so the placeholder set at send time is gone and the fresh state reads idle.
 */
export function shouldAcceptStreamFrame(params: {
  frameSessionId: string | undefined;
  frameQuestId: string | undefined;
  sessionId: string | null;
  pendingSessionId: string | null;
  current: Pick<IChatCompletion, 'completed' | 'quest'>;
  mintingOwnSession?: boolean;
}): boolean {
  const { frameSessionId, frameQuestId, sessionId, pendingSessionId, current, mintingOwnSession } = params;
  if (!frameSessionId) return false;
  if (frameSessionId === sessionId) return true;
  if (!isCreatingSession(sessionId)) return false;
  if (pendingSessionId && frameSessionId === pendingSessionId) return true;
  if (current.quest?.id) return current.quest.id === frameQuestId;
  return !current.completed || !!mintingOwnSession;
}

/**
 * Whether switching the viewed session from `prevSessionId` to `nextSessionId` must drop the
 * held state. Kept only when it belongs to the new session, or while the tab's own send is
 * minting it (null/optimistic -> optimistic -> real).
 */
export function shouldResetOnSessionChange(
  prevSessionId: string | null,
  nextSessionId: string | null,
  current: Pick<IChatCompletion, 'quest'>
): boolean {
  if (isOptimisticId(nextSessionId)) return false;
  if (!nextSessionId) return true;
  const questSessionId = current.quest?.sessionId;
  if (questSessionId) return questSessionId !== nextSessionId;
  return !isCreatingSession(prevSessionId);
}

/** Whether the composer should show Stop for `sessionId`. */
export function isChatCompletionActiveFor(chatCompletion: IChatCompletion, sessionId: string | null): boolean {
  const active =
    !chatCompletion.completed && (!!chatCompletion.statusMessage || chatCompletion.quest?.status === 'running');
  if (!active) return false;
  const questSessionId = chatCompletion.quest?.sessionId;
  // No session on the quest yet: the tab's own send, still awaiting its first frame.
  if (!questSessionId) return true;
  return questSessionId === sessionId || isOptimisticId(sessionId);
}

const TERMINAL_QUEST_LIMIT = 100;

const toMs = (value: Date | string | undefined | null): number | null => {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Remembers quests already seen terminal so a retried or reordered 'running' frame that
 * lands after 'done'/'stopped' can't flip the composer back to Stop. updatedAt alone can't
 * order them: it rarely changes between chunks of one run.
 */
export class TerminalQuestTracker {
  private readonly terminal = new Map<string, number | null>();

  constructor(private readonly limit = TERMINAL_QUEST_LIMIT) {}

  markTerminal(questId: string, updatedAt?: Date | string | null): void {
    this.terminal.delete(questId);
    this.terminal.set(questId, toMs(updatedAt));
    if (this.terminal.size > this.limit) {
      const oldest = this.terminal.keys().next().value;
      if (oldest !== undefined) this.terminal.delete(oldest);
    }
  }

  /** Drops the mark, for a caller that deliberately re-runs an existing quest id. */
  forget(questId: string): void {
    this.terminal.delete(questId);
  }

  /**
   * True for a non-terminal frame of a quest already seen terminal. A strictly newer
   * updatedAt means the server restarted the quest, so it is let through (and unmarked).
   */
  isStaleFrame(questId: string, status: string | null | undefined, updatedAt?: Date | string | null): boolean {
    if (isTerminalQuestStatus(status) || !this.terminal.has(questId)) return false;
    const terminalAt = this.terminal.get(questId) ?? null;
    const incomingAt = toMs(updatedAt);
    if (terminalAt !== null && incomingAt !== null && incomingAt > terminalAt) {
      this.terminal.delete(questId);
      return false;
    }
    return true;
  }
}

// One per tab: the chat-completion subscription is mounted once (ChatCompletionProvider),
// and re-run callers (handleLLMCommand with an existing questId) must reach the same marks.
export const terminalQuests = new TerminalQuestTracker();

/**
 * Stop request failed. Revert to the pre-stop state while the quest may still be running;
 * mark it complete once the cache says it has ended. A frame that already moved the state
 * past "Cancelling..." wins.
 */
export function resolveStopFailure(
  current: IChatCompletion,
  beforeStop: IChatCompletion,
  cachedQuestStatus: string | null | undefined,
  cancellingStatusMessage: string
): IChatCompletion {
  if (current.statusMessage !== cancellingStatusMessage) return { ...current, stopped: false };
  if (isTerminalQuestStatus(cachedQuestStatus))
    return { ...current, completed: true, stopped: false, statusMessage: undefined };
  return {
    ...current,
    // Frames that landed meanwhile advanced the held quest; only a placeholder is reverted.
    quest: current.quest?.id ? current.quest : beforeStop.quest,
    stopped: false,
    statusMessage: beforeStop.statusMessage,
  };
}

/**
 * After the send request returns, pin the quest it created so the recovery poll has an id to
 * reconcile against if the websocket never delivers the stream. No-op once a frame has already
 * adopted a quest or the turn has ended.
 */
export function adoptSentQuest(
  current: IChatCompletion,
  quest: Pick<IChatHistoryItemDocument, 'id' | 'sessionId' | 'type' | 'status'>
): IChatCompletion {
  if (current.completed || current.quest?.id) return current;
  return {
    ...current,
    quest: { id: quest.id, sessionId: quest.sessionId, type: quest.type, status: quest.status ?? 'running' },
  };
}
