import { User, realtimeConnectionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { authSessionService } from '@bike4mind/services';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';

/** `not_due`: never requested, cancelled, or the grace period has not passed. `not_found`: the user is gone. */
export type AccountDeletionSkipReason = 'not_due' | 'not_found';
export type AccountDeletionCompletion = { deleted: true } | { deleted: false; reason: AccountDeletionSkipReason };

class DeletionNoLongerDue extends Error {}

const dueFilter = (userId: string, now: Date) => ({ _id: userId, 'deletion.scheduledFor': { $lte: now } });

/**
 * Hard-delete one account whose self-serve deletion grace period has passed, through the admin delete's
 * path (hardDeleteUser), then mail the deletion-complete email to the address read before the delete.
 * Re-checks the deletion both before and inside the delete's transaction, so a cancel that lands after
 * the caller listed the account wins. Safe to re-run: a deleted account is not found again.
 */
export async function completeAccountDeletion(
  userId: string,
  { logger, now = new Date() }: { logger: Pick<Logger, 'info' | 'warn' | 'error'>; now?: Date }
): Promise<AccountDeletionCompletion> {
  // Read before the delete: the row is gone once it commits.
  const user = await User.findOne(dueFilter(userId, now), 'email').lean<{ email?: string | null }>();
  if (!user) return { deleted: false, reason: (await User.exists({ _id: userId })) ? 'not_due' : 'not_found' };

  try {
    await hardDeleteUser(
      userId,
      {
        deletedBy: userId,
        initiatedBy: 'self',
        logger,
        assertInTransaction: async () => {
          if (!(await User.exists(dueFilter(userId, now)))) throw new DeletionNoLongerDue();
        },
      },
      async users => {
        await users.delete(userId);
        await authSessionService.endRealtimeConnections(
          { userId },
          { db: { realtimeConnections: realtimeConnectionRepository } }
        );
      }
    );
  } catch (error) {
    if (error instanceof DeletionNoLongerDue) return { deleted: false, reason: 'not_due' };
    throw error;
  }
  logger.info(`[AccountDeletion] Deleted user ${userId} whose deletion grace period ended`);

  if (user.email) {
    try {
      await sendAccountDeletionCompleteEmail(user.email);
    } catch (err) {
      logger.error(`Failed to send the deletion-complete email for user ${userId}: ${String(err)}`);
    }
  }
  return { deleted: true };
}
