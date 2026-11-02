import { userRepository, withTransaction } from '@bike4mind/database';
import type { IUserDocument, IUserRepository } from '@bike4mind/common';
import {
  purgeDeletedUserData,
  readUserIntegrationGrants,
  type UserIntegrationGrants,
} from '@server/services/purgeDeletedUserData';
import { emitBillingEvent } from '@server/analytics/signupEvents';
import { wholeDaysBetween } from '@server/analytics/billingEventDetails';
import { pseudonymizeUserId } from '@bike4mind/server-utils/analytics/pseudonymize';
import { resolveUserType } from '@server/analytics/resolveUserType';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export type HardDeleteContext = {
  /** Who the purge records as the deleter: the admin's id, or the user's own for a self-service deletion. */
  deletedBy: string;
  /** Whose request this was, for the account_deleted analytics event. */
  initiatedBy: 'admin' | 'self';
  logger: MinimalLogger;
  /** Runs inside the delete's transaction, so e.g. an admin audit entry commits or rolls back with the row. */
  recordInTransaction?: (target: IUserDocument | null) => Promise<void>;
};

/**
 * The account's own churn, for Overwatch: to the host, and to the product the user came through.
 * The occurrence is the pseudonym, never the raw id, which an eventId is sent verbatim beside.
 * Never throws: it runs in a `finally`, where a throw would replace the request's own error.
 */
async function emitAccountDeleted(account: IUserDocument | null, initiatedBy: HardDeleteContext['initiatedBy']) {
  if (!account) return;
  try {
    const daysSinceSignup = wholeDaysBetween(account.createdAt, new Date());
    await emitBillingEvent({
      user: account,
      event: 'account_deleted',
      occurrence: pseudonymizeUserId(account.id),
      metadata: {
        initiatedBy,
        wasSubscriber:
          resolveUserType({ level: account.level, subscribedUntil: account.subscribedUntil }) === 'subscriber',
        ...(daysSinceSignup !== undefined && { daysSinceSignup }),
      },
    });
  } catch {
    console.warn('[b4m-analytics] account_deleted not sent');
  }
}

/**
 * The one hard-delete path for a user, shared by the admin delete route (pages/api/users/[id]/delete.ts)
 * and the self-service deletion sweep (apps/workers/src/cron/accountDeletionSweep.ts).
 *
 * `commitDelete` runs the caller's service call (its authorization and notifications) with a users
 * repository whose `delete` reads the integration grants first, then deletes the row in a transaction
 * with `recordInTransaction`. Once that commits, the purge and the account_deleted event run in a
 * `finally`: a throw after the commit (a failed notification) must not skip them, because a retry
 * would find no row and nothing would run them again.
 */
export async function hardDeleteUser<T>(
  userId: string,
  context: HardDeleteContext,
  commitDelete: (users: IUserRepository) => Promise<T>
): Promise<T> {
  let deleteCommitted = false;
  let integrationGrants: UserIntegrationGrants | null = null;
  let deletedAccount: IUserDocument | null = null;
  const users: IUserRepository = Object.create(userRepository, {
    delete: {
      value: async (id: string) => {
        // Captured right before the row goes: the purge needs them to revoke the provider grants,
        // and they are unreadable once the delete commits.
        integrationGrants = await readUserIntegrationGrants(id);
        const target = await userRepository.findById(id);
        deletedAccount = target;
        const result = await withTransaction(async () => {
          const deleted = await userRepository.delete(id);
          await context.recordInTransaction?.(target);
          return deleted;
        });
        deleteCommitted = true;
        return result;
      },
    },
  });

  try {
    return await commitDelete(users);
  } finally {
    if (deleteCommitted) {
      await purgeDeletedUserData(userId, {
        deletedBy: context.deletedBy,
        logger: context.logger,
        integrationGrants,
      });
      await emitAccountDeleted(deletedAccount, context.initiatedBy);
    }
  }
}
