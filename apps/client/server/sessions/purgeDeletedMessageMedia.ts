import { Session } from '@bike4mind/database';
import type { MinimalLogger } from '@server/services/publish/minimalLogger';
import { enqueueGeneratedMediaPurge } from '@server/sessions/generatedMediaPurgeQueue';
import {
  PURGE_BUDGET_MS,
  isGeneratedContentKey,
  runGeneratedMediaPurge,
} from '@server/sessions/purgeDeletedNotebookMedia';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * After one message is deleted, remove the generated images and videos no other live message or live
 * file references and that its notebook's owner provably produced (findOwnedKeys), and invalidate
 * their `/generated/<key>` CDN paths. Call only once the delete has committed. Retention is per
 * message, not per notebook: the notebook itself is still live. What the request budget does not
 * reach goes to the purge queue. Never throws; failures are logged.
 */
export async function purgeDeletedMessageMedia(
  message: { id: string; sessionId: string; images?: string[] | null; videos?: string[] | null },
  { logger }: { logger: MinimalLogger }
): Promise<void> {
  const keys = [...new Set([...(message.images ?? []), ...(message.videos ?? [])])].filter(isGeneratedContentKey);
  if (keys.length === 0) return;
  try {
    const session = await Session.findById(message.sessionId, { userId: 1 })
      .setOptions({ includeDeleted: true })
      .lean();
    if (!session?.userId) return;
    const leftovers = await runGeneratedMediaPurge(
      { keys, ownerIds: [String(session.userId)] },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(), logger }
    );
    await enqueueGeneratedMediaPurge({ keys: leftovers.leftoverKeys, ownerIds: leftovers.ownerIds }, logger);
  } catch (err) {
    logger.warn(`[MESSAGE_MEDIA] Could not purge generated media of a deleted message: ${errorMessage(err)}`);
  }
}
