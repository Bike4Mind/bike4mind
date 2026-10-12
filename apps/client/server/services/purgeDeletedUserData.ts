import { embedConversationRepository, hideDeletedAuthorAnnotations } from '@bike4mind/database';
import { purgeUserPublishedArtifacts } from '@server/services/publish/purgeUserPublishedArtifacts';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * Remove the data a deleted account leaves behind that nothing else would ever reach. Call it
 * from every path that deletes a user, AFTER the delete has been authorized and committed.
 *
 * Each step is best-effort and independent: the account is already gone, so one failure must
 * not skip the others or surface as an error a retry cannot fix. Every step is idempotent, so
 * re-running this for the same id is safe. Backstops for a failed step: the embed collection's
 * TTL index, the publish serve route refusing artifacts whose owner no longer exists, and the
 * orphan backfill (packages/scripts/src/backfillOrphanedPublishedArtifacts.ts) for annotations.
 */
export async function purgeDeletedUserData(
  userId: string,
  { deletedBy, logger }: { deletedBy: string; logger: MinimalLogger }
): Promise<void> {
  try {
    await embedConversationRepository.deleteAllForUser(userId);
  } catch (err) {
    logger.error(`Failed to purge embed conversations for deleted user ${userId}: ${String(err)}`);
  }

  try {
    await purgeUserPublishedArtifacts(userId, { deletedBy, logger });
  } catch (err) {
    logger.error(`Failed to purge published artifacts for deleted user ${userId}: ${String(err)}`);
  }

  // After the artifact purge, so this only catches what the user wrote on pages that stay live.
  try {
    const hidden = await hideDeletedAuthorAnnotations(userId);
    logger.info(`Hid ${hidden} annotation(s) written by deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to hide annotations for deleted user ${userId}: ${String(err)}`);
  }
}
