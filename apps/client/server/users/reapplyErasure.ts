import { Organization, userRepository, withTransaction, type ErasureInitiator } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { purgeDeletedUserData } from '@server/services/purgeDeletedUserData';
import { purgeAccountContent } from './purgeAccountContent';
import { purgeAccountFiles } from './purgeAccountFiles';

type ReapplyLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/**
 * Erase an account again after a database restore brought its rows back, repeating what the original
 * path removed (record.initiatedBy): a self-serve or unknown-path erasure also purges files, content and
 * the personal org (completeAccountDeletion.ts); an admin one deletes the row and runs the shared
 * purge (pages/api/users/[id]/delete.ts). Keep in sync with those and with hardDeleteUser.ts.
 *
 * Deliberately sends nothing: no subscription cancel, deletion email, analytics event or Slack/email
 * notification, and `integrationGrants: null` skips the provider revokes. The original erasure already
 * did those, and repeating them would bill, mail or notify someone about a stale event.
 * Every step is idempotent, so a failed run can simply be re-run.
 */
export async function reapplyErasure(
  userId: string,
  { initiatedBy, logger }: { initiatedBy: ErasureInitiator; logger: ReapplyLogger }
): Promise<void> {
  if (initiatedBy !== 'admin') {
    const assertLease = async () => {}; // no purge lease: the account is already past its grace period
    await purgeAccountFiles(userId, { logger, assertLease });
    await purgeAccountContent(userId, { logger, assertLease });
    await withTransaction(async () => {
      await Organization.deleteMany({ userId, personal: true }, { hardDelete: true });
      await userRepository.delete(userId);
    });
  } else {
    await withTransaction(async () => {
      await userRepository.delete(userId);
    });
  }
  await purgeDeletedUserData(userId, { deletedBy: 'erasure-reapply', logger, integrationGrants: null });
}
