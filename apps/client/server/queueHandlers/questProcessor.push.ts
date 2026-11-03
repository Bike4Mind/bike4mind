import type { PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { hasLiveConnection, isPushDeliveryConfigured, truncateForPush } from '@server/utils/pushNotifications';

export type ChatCompletedPushDeps = {
  connections: { findByUserId(userId: string): Promise<unknown[]> };
  findQuest(questId: string): Promise<{ status?: string; type?: string; reply?: string | null } | null>;
  sessionDeepLink(sessionId: string): string;
  /** Must not throw (publishPushNotification). */
  publish(event: PushNotificationEvent): Promise<void>;
};

/**
 * `chat_completed` push for a finished chat turn, sent only when the user has no live websocket
 * connection: a connected client already streamed the reply, so the push would only duplicate it.
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
