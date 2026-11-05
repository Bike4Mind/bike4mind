import { randomUUID } from 'node:crypto';
import { Organization, User, realtimeConnectionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { authSessionService } from '@bike4mind/services';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';
import { purgeAccountContent } from './purgeAccountContent';
import { purgeAccountFiles } from './purgeAccountFiles';

type DeletionLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
export type AccountDeletionSkipReason = 'not_due' | 'not_found';
export type AccountDeletionCompletion = { deleted: true } | { deleted: false; reason: AccountDeletionSkipReason };

// Longer than the hosted sweep's ten-minute timeout. An abandoned invocation becomes resumable,
// while the permanent purgeStartedAt marker keeps cancellation closed after any data was removed.
const PURGE_LEASE_MS = 15 * 60 * 1000;
const dueFilter = (userId: string, now: Date) => ({ _id: userId, 'deletion.scheduledFor': { $lte: now } });

const assertNoOwnedOrganizations = async (userId: string): Promise<void> => {
  if (await Organization.exists({ userId, deletedAt: null, personal: { $ne: true } })) {
    throw new Error(`Account deletion refused: user ${userId} still owns an organization`);
  }
};

async function claimPurge(userId: string, now: Date, leaseId: string) {
  const lease = {
    'deletion.purgeLeaseId': leaseId,
    'deletion.purgeLeaseExpiresAt': new Date(Date.now() + PURGE_LEASE_MS),
  };
  const projection = { email: 1 };
  const noLiveExport = {
    $or: [{ 'accountDataExportLease.expiresAt': null }, { 'accountDataExportLease.expiresAt': { $lte: new Date() } }],
  };
  const firstClaim = await User.findOneAndUpdate(
    { ...dueFilter(userId, now), 'deletion.purgeStartedAt': null, ...noLiveExport },
    { $set: { ...lease, 'deletion.purgeStartedAt': new Date() } },
    { new: true, projection }
  ).lean<{ email?: string | null }>();
  if (firstClaim) return firstClaim;

  // A retry updates only the lease: the first irreversible attempt remains recorded permanently.
  return User.findOneAndUpdate(
    {
      ...dueFilter(userId, now),
      'deletion.purgeStartedAt': { $ne: null },
      $and: [
        noLiveExport,
        { $or: [{ 'deletion.purgeLeaseExpiresAt': null }, { 'deletion.purgeLeaseExpiresAt': { $lte: new Date() } }] },
      ],
    },
    { $set: lease },
    { new: true, projection }
  ).lean<{ email?: string | null }>();
}

/**
 * Claim the irreversible phase atomically against cancellation, remove personal data while the
 * pending user row remains the retry record, then delete that row through the shared admin path.
 * Every purge step is idempotent. A failed step releases this invocation's lease, keeps the account
 * locked, and is retried by the next sweep; a live competing lease is skipped.
 */
export async function completeAccountDeletion(
  userId: string,
  { logger, now = new Date() }: { logger: DeletionLogger; now?: Date }
): Promise<AccountDeletionCompletion> {
  if (!(await User.exists(dueFilter(userId, now)))) {
    return { deleted: false, reason: (await User.exists({ _id: userId })) ? 'not_due' : 'not_found' };
  }
  await assertNoOwnedOrganizations(userId);
  const leaseId = randomUUID();
  const user = await claimPurge(userId, now, leaseId);
  if (!user) return { deleted: false, reason: 'not_due' };

  const leaseFilter = { ...dueFilter(userId, now), 'deletion.purgeLeaseId': leaseId };
  const assertLease = async () => {
    if (!(await User.exists({ ...leaseFilter, 'deletion.purgeLeaseExpiresAt': { $gt: new Date() } }))) {
      throw new Error(`Account deletion purge lease lost for user ${userId}`);
    }
  };

  try {
    await purgeAccountFiles(userId, { logger, assertLease });
    await purgeAccountContent(userId, { logger, assertLease });
    await assertLease();
    await authSessionService.endRealtimeConnections(
      { userId },
      { db: { realtimeConnections: realtimeConnectionRepository } }
    );
    await hardDeleteUser(
      userId,
      {
        deletedBy: userId,
        initiatedBy: 'self',
        logger,
        assertInTransaction: async () => {
          await assertLease();
          await assertNoOwnedOrganizations(userId);
        },
        // Keep billing references until hardDeleteUser has captured every customer ID. Remove
        // personal workspace rows atomically with the final user deletion, never during a retry.
        recordInTransaction: async () => {
          await Organization.deleteMany({ userId, personal: true }, { hardDelete: true });
        },
      },
      users => users.delete(userId)
    );
  } catch (error) {
    try {
      await User.updateOne(
        { _id: userId, 'deletion.purgeLeaseId': leaseId },
        { $unset: { 'deletion.purgeLeaseId': 1, 'deletion.purgeLeaseExpiresAt': 1 } }
      );
    } catch (releaseError) {
      logger.error(`Failed to release account deletion lease for user ${userId}: ${String(releaseError)}`);
    }
    throw error;
  }
  logger.info(`[AccountDeletion] Deleted user ${userId} whose deletion grace period ended`);
  if (user.email) {
    try {
      await sendAccountDeletionCompleteEmail(user.email);
    } catch (error) {
      logger.error(`Failed to send the deletion-complete email for user ${userId}: ${String(error)}`);
    }
  }
  return { deleted: true };
}
