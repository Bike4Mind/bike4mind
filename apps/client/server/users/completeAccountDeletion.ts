import { randomUUID } from 'node:crypto';
import { ADMIN_ERASURE_COMPLETED_ACTION, type AdminErasureCollection, type IUserDeletion } from '@bike4mind/common';
import {
  Organization,
  User,
  adminAuditLogRepository,
  mongoose,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { adminAuditService, authSessionService } from '@bike4mind/services';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { systemAuditActor } from '@server/utils/adminAudit';
import { SubjectErasurePlan, unerased } from '@server/dataSubject/subjectErasurePlan';
import { findUnclassifiedModels } from '@server/dataSubject/registry';
import { assertEveryModelClassified } from '@server/dataSubject/subjectMatcher';
import { sendAccountDeletionCompleteEmail } from './accountDeletionEmail';
import { purgeAccountContent } from './purgeAccountContent';
import { purgeAccountFiles } from './purgeAccountFiles';

type DeletionLogger = Pick<Logger, 'info' | 'warn' | 'error'>;
/** `busy`: due, but another purge or a data export holds the account's lease; retry later. */
export type AccountDeletionSkipReason = 'not_due' | 'not_found' | 'busy';
export type AccountDeletionCompletion = { deleted: true } | { deleted: false; reason: AccountDeletionSkipReason };

// Longer than the hosted sweep's ten-minute timeout and no shorter than the erasure queue consumer's
// fifteen (infra/queues.ts), whose redelivery after sixteen can then reclaim it. An abandoned
// invocation becomes resumable, while the permanent purgeStartedAt marker keeps cancellation closed
// after any data was removed.
const PURGE_LEASE_MS = 15 * 60 * 1000;
type ClaimedUser = {
  email?: string | null;
  deletion?: Pick<IUserDeletion, 'source' | 'requestedBy' | 'erasureScope'>;
};

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
  const projection = {
    email: 1,
    'deletion.source': 1,
    'deletion.requestedBy': 1,
    'deletion.erasureScope': 1,
  };
  const noLiveExport = {
    $or: [{ 'accountDataExportLease.expiresAt': null }, { 'accountDataExportLease.expiresAt': { $lte: new Date() } }],
  };
  const firstClaim = await User.findOneAndUpdate(
    { ...dueFilter(userId, now), 'deletion.purgeStartedAt': null, ...noLiveExport },
    { $set: { ...lease, 'deletion.purgeStartedAt': new Date() } },
    { new: true, projection }
  ).lean<ClaimedUser>();
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
  ).lean<ClaimedUser>();
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
  if (!user) return { deleted: false, reason: 'busy' };

  const leaseFilter = { ...dueFilter(userId, now), 'deletion.purgeLeaseId': leaseId };
  const assertLease = async () => {
    if (!(await User.exists({ ...leaseFilter, 'deletion.purgeLeaseExpiresAt': { $gt: new Date() } }))) {
      throw new Error(`Account deletion purge lease lost for user ${userId}`);
    }
  };

  const erasure = user.deletion?.source === 'admin' ? { requestedBy: user.deletion.requestedBy ?? null } : null;
  const subject = { userId, email: user.email ?? null };

  try {
    // Snapshot once: a retry after a partial purge would count less, and the record must describe it all.
    let scope = user.deletion?.erasureScope;
    if (erasure && !scope) {
      assertEveryModelClassified(mongoose.modelNames());
      scope = await new SubjectErasurePlan(subject).collections(assertLease);
      const stored = await User.updateOne(leaseFilter, { $set: { 'deletion.erasureScope': scope } });
      if (stored.matchedCount === 0) throw new Error(`Account deletion purge lease lost for user ${userId}`);
    }
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
        deletedBy: erasure?.requestedBy ?? userId,
        initiatedBy: erasure ? 'admin' : 'self',
        logger,
        assertInTransaction: async () => {
          await assertLease();
          await assertNoOwnedOrganizations(userId);
        },
        // Keep billing references until hardDeleteUser has captured every customer ID. Remove
        // personal workspace rows atomically with the final user deletion, never during a retry.
        // The admin audit entry commits with the delete, as the admin delete route's does.
        recordInTransaction: async target => {
          await Organization.deleteMany({ userId, personal: true }, { hardDelete: true });
          await adminAuditService.recordAdminAction(
            {
              action: 'user.deletion.completed',
              actor: systemAuditActor('account-deletion-sweep'),
              // An erasure's record outlives the person, so it names them by id only.
              target: {
                kind: 'user',
                id: userId,
                displayName: erasure ? userId : target?.name || target?.username || userId,
              },
              summary: erasure
                ? 'deleted the user for a data subject erasure an admin requested'
                : 'deleted the user at their own request once the deletion grace period ended',
              details: erasure
                ? { initiatedBy: 'admin', requestedBy: erasure.requestedBy, scope }
                : { initiatedBy: 'self' },
              context: { source: 'worker' },
            },
            { db: { adminAuditLog: adminAuditLogRepository }, logger }
          );
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

  if (erasure) {
    logger.info(`[AccountDeletion] Deleted user ${userId} for an admin data subject erasure`);
    await recordErasureCompleted(subject, erasure.requestedBy, logger);
    // No email: the person did not ask for this, and the admin who did tells them through their own channel.
    return { deleted: true };
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

/**
 * After the user row is gone, what the data holder registry still finds naming the person and does not
 * keep for a stated reason. Counts only. The user is already deleted, so a failure here is logged at
 * error and never thrown: a retry could not find the user, and `user.deletion.completed` already holds
 * the scope.
 */
async function recordErasureCompleted(
  subject: { userId: string; email: string | null },
  requestedBy: string | null,
  logger: DeletionLogger
): Promise<void> {
  try {
    // A model the registry does not classify was not checked, so it is listed rather than passed over.
    const unclassified = findUnclassifiedModels(mongoose.modelNames());
    const remaining: AdminErasureCollection[] = unerased(await new SubjectErasurePlan(subject).collections());
    const clean = remaining.length === 0 && unclassified.length === 0;
    await adminAuditService.recordAdminAction(
      {
        action: ADMIN_ERASURE_COMPLETED_ACTION,
        actor: systemAuditActor('account-deletion-sweep'),
        target: { kind: 'user', id: subject.userId, displayName: subject.userId },
        summary: clean
          ? 'completed a data subject erasure; nothing outside the stated retentions still names the user'
          : `completed a data subject erasure; ${remaining.length} collection(s) still name the user and ` +
            `${unclassified.length} unclassified model(s) were not checked`,
        details: { requestedBy, remaining, unclassified },
        context: { source: 'worker' },
      },
      { db: { adminAuditLog: adminAuditLogRepository }, logger }
    );
  } catch (error) {
    logger.error(`Failed to record the erasure check for deleted user ${subject.userId}: ${String(error)}`);
  }
}
