import type { LiveActivityPushEvent, PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { createLiveActivityThrottle } from '@server/utils/liveActivityPush';
import {
  type ConnectionLookup,
  hasLiveConnection,
  isPushDeliveryConfigured,
  truncateForPush,
} from '@server/utils/pushNotifications';

export type ChatCompletedPushDeps = {
  connections: ConnectionLookup;
  findQuest(questId: string): Promise<{
    status?: string;
    type?: string;
    reply?: string | null;
    pendingAction?: { tool: string } | null;
  } | null>;
  sessionDeepLink(sessionId: string): string;
  /** Must not throw (publishPushNotification). */
  publish(event: PushNotificationEvent): Promise<void>;
};

/**
 * `chat_completed` push for a finished chat turn, sent only when the user has no live websocket
 * connection: a connected client already streamed the reply, so the push would only duplicate it.
 * A turn that ended parked on a Confirm card (an MCP write preview saved by ToolBuilder's
 * onPendingAction) sends `approval_needed` instead, with the same copy and collapse id as the agent
 * path (apps/workers/src/queueHandlers/agentExecutor.pendingAction.ts).
 * API-key turns are skipped too; their caller polls or streams the result itself. Never throws.
 */
export async function publishChatCompletedPush(
  turn: { userId: string; sessionId: string; questId: string; sessionName?: string; apiKeyId?: string },
  deps: ChatCompletedPushDeps,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (turn.apiKeyId || !isPushDeliveryConfigured()) return;
  try {
    if (await hasLiveConnection(turn.userId, deps.connections, logger)) return;
    const quest = await deps.findQuest(turn.questId);
    if (!quest || quest.status !== 'done' || quest.type === 'error') return;

    if (quest.pendingAction) {
      await deps.publish({
        userId: turn.userId,
        category: 'approval_needed',
        title: 'Approval needed',
        body: `An agent wants to run ${quest.pendingAction.tool} and is waiting for your confirmation.`,
        deepLink: deps.sessionDeepLink(turn.sessionId),
        collapseId: `approval:${turn.questId}`,
        questId: turn.questId,
        sessionId: turn.sessionId,
      });
      return;
    }

    const sessionName = turn.sessionName?.trim();
    const replySnippet = quest.reply?.replace(/\s+/g, ' ').trim();
    await deps.publish({
      userId: turn.userId,
      category: 'chat_completed',
      title: sessionName ? truncateForPush(sessionName, 60) : 'Reply ready',
      body: replySnippet ? truncateForPush(replySnippet, 160) : 'Your reply is ready.',
      deepLink: deps.sessionDeepLink(turn.sessionId),
      collapseId: `chat:${turn.questId}`,
      questId: turn.questId,
      sessionId: turn.sessionId,
    });
  } catch (error) {
    logger.warn('[Push] chat completed push failed', {
      questId: turn.questId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type ChatLiveActivityDeps = {
  findQuest(questId: string): Promise<{ status?: string; type?: string } | null>;
  /** Must not throw (publishLiveActivityUpdate). */
  publishLiveActivity(event: LiveActivityPushEvent): Promise<void>;
};

export type ChatLiveActivity = {
  /**
   * For ChatCompletionProcess's `onStatusUpdate`: mirrors the turn's status lines, throttled. Never throws.
   * Absent when the turn has no activity, so the chat path installs no status observer at all.
   */
  onStatusUpdate?: (questId: string, status: string) => void;
  /** Ends the activity once the turn has settled, reading the quest for how it ended. Never throws. */
  end(outcome?: 'failed'): Promise<void>;
};

const MAX_STAGE_LABEL_LENGTH = 60;

/**
 * The live activity of one chat turn (quest). API-key turns have no activity, and neither does any turn
 * while push delivery is unconfigured: `end` then resolves at once with no quest read and no publish.
 * Unlike the `chat_completed` push this is not gated on a live websocket: an activity exists while
 * the user may be away from the app.
 */
export function createChatLiveActivity(
  turn: { userId: string; questId: string; apiKeyId?: string },
  deps: ChatLiveActivityDeps,
  logger: Pick<Logger, 'warn'>
): ChatLiveActivity {
  if (turn.apiKeyId || !isPushDeliveryConfigured()) return { end: async () => undefined };
  const throttle = createLiveActivityThrottle(deps.publishLiveActivity);

  return {
    onStatusUpdate(questId, status) {
      if (questId !== turn.questId) return;
      void throttle
        .emit({
          userId: turn.userId,
          questId: turn.questId,
          event: 'update',
          contentState: { status: 'running', stageLabel: truncateForPush(status.trim(), MAX_STAGE_LABEL_LENGTH) },
        })
        .catch(error =>
          logger.warn('[LiveActivity] chat status update failed', {
            questId: turn.questId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
    },
    async end(outcome) {
      try {
        const quest = outcome ? null : await deps.findQuest(turn.questId);
        const contentState: LiveActivityPushEvent['contentState'] =
          outcome === 'failed' || quest?.type === 'error'
            ? { status: 'failed', errored: true }
            : quest?.status === 'stopped'
              ? { status: 'stopped' }
              : { status: 'completed' };
        await throttle.emit({ userId: turn.userId, questId: turn.questId, event: 'end', contentState });
      } catch (error) {
        logger.warn('[LiveActivity] chat live activity end failed', {
          questId: turn.questId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
