/**
 * What the legacy chat image paths did once a turn was written, for POST /api/image-jobs: the quest frame to the
 * requester's other open tabs (ImageGeneration / ImageEdit `streamed_chat_completion`), and, for a generation only,
 * the notebook naming event and summary check (ImageGeneration's invokeSessionAutoNaming and maybeSummarizeAfterImage). Both are best-effort: neither fails the send.
 */
import type { IChatHistoryItemDocument, ISessionDocument } from '@bike4mind/common';
import { questRepository } from '@bike4mind/database';
import { shouldSummarizeSession } from '@bike4mind/services/llm';
import { SessionEvents } from '@bike4mind/server-utils/utils/eventBus';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';
import type { Request } from 'express';

type Logger = Request['logger'];

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The settled turn, in the same frame the legacy paths ended on, so another tab shows it without a refetch. */
export async function broadcastChatImageQuest(
  userId: string,
  quest: IChatHistoryItemDocument,
  logger: Logger
): Promise<void> {
  try {
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'streamed_chat_completion',
      quest: {
        id: quest.id,
        sessionId: quest.sessionId,
        reply: quest.reply,
        replies: quest.replies,
        type: quest.type,
        status: quest.status,
        images: quest.images,
        generationJobs: quest.generationJobs,
        errorCode: quest.errorCode,
      },
      statusMessage: null,
    });
  } catch (error) {
    logger.warn('[image-jobs] could not send the turn to the requester tabs', {
      questId: quest.id,
      error: errorMessage(error),
    });
  }
}

/**
 * Publishes the notebook summary when the session is due, exactly as the legacy generation did: the requester pays,
 * and the decision costs one indexed quest count (none while throttled). The summary itself runs on the event.
 */
export async function maybeSummarizeAfterChatImage(
  session: ISessionDocument,
  payerId: string,
  logger: Logger
): Promise<void> {
  try {
    const [due, trigger] = await shouldSummarizeSession(session, { db: { quests: questRepository }, logger });
    if (!due) return;
    await SessionEvents.Summarize.publish({ sessionId: session.id, callTagging: true, trigger, payerId });
  } catch (error) {
    logger.warn('[image-jobs] notebook summary check failed', { sessionId: session.id, error: errorMessage(error) });
  }
}

/**
 * Publishes the notebook naming event on every generation, as the legacy generation did, so a new notebook started
 * with an image send is named. The handler (apps/workers/src/events/sessionAutoNaming.ts) skips one already auto-named.
 */
export async function nameNotebookAfterChatImage(sessionId: string, userId: string, logger: Logger): Promise<void> {
  try {
    await SessionEvents.AutoName.publish({ sessionId, userId });
  } catch (error) {
    logger.warn('[image-jobs] notebook naming dispatch failed', { sessionId, error: errorMessage(error) });
  }
}
