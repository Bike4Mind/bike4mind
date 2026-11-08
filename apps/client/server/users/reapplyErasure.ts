import {
  Organization,
  erasureRecordRepository,
  realtimeConnectionRepository,
  userRepository,
  withTransaction,
  type IErasureRecord,
} from '@bike4mind/database';
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
 * Sends no notifications or billing calls: no subscription cancel, deletion email, analytics event or
 * Slack/email notification, and `integrationGrants: null` skips the provider revokes. The original
 * erasure already did those, and repeating them would bill, mail or notify someone about a stale
 * event. It does repeat the idempotent storage, CDN-invalidation and search-index deletes.
 *
 * The record is written in the same transaction as the row delete, so the restored database holds
 * proof of the erasure again. The purge sub-steps after the delete log and swallow their own errors,
 * and a re-run no longer finds the user: a caller must treat any logged error as a partial purge that
 * needs a manual follow-up.
 *
 * Returns the ids of non-personal organisations the account still owned in the restored data: they are
 * left without an owner and need reassigning.
 */
export async function reapplyErasure(
  userId: string,
  { record, logger }: { record: IErasureRecord; logger: ReapplyLogger }
): Promise<{ ownedOrganizationIds: string[] }> {
  const owned = await Organization.find({ userId, deletedAt: null, personal: { $ne: true } }, { _id: 1 }).lean();
  const writeRecord = () => erasureRecordRepository.record(record);
  // Fail before deleting the retry anchor if realtime invalidation cannot complete. Unlike the
  // best-effort revoke service, replay must report a partial erasure as a failure.
  await realtimeConnectionRepository.endConnections({ userId });
  if (record.initiatedBy !== 'admin') {
    const assertLease = async () => {}; // no purge lease: the account is already past its grace period
    await purgeAccountFiles(userId, { logger, assertLease });
    await purgeAccountContent(userId, { logger, assertLease });
    await withTransaction(async () => {
      await Organization.deleteMany({ userId, personal: true }, { hardDelete: true });
      await userRepository.delete(userId);
      await writeRecord();
    });
  } else {
    await withTransaction(async () => {
      await userRepository.delete(userId);
      await writeRecord();
    });
  }
  // A restored account can reconnect during a long purge. Once its row is gone, close that
  // window with another invalidation; failures propagate as a partial purge needing follow-up.
  try {
    await realtimeConnectionRepository.endConnections({ userId });
  } finally {
    await purgeDeletedUserData(userId, { deletedBy: 'erasure-reapply', logger, integrationGrants: null });
  }
  return { ownedOrganizationIds: owned.map(o => String(o._id)) };
}
