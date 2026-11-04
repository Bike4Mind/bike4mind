import { userRepository, withTransaction } from '@bike4mind/database';
import type { IUserDocument, IUserRepository } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { pseudonymizeUserId } from '@bike4mind/server-utils/analytics/pseudonymize';
import { emitBillingEvent } from '@server/analytics/signupEvents';
import { wholeDaysBetween } from '@server/analytics/billingEventDetails';
import { resolveUserType } from '@server/analytics/resolveUserType';
import {
  cancelAccountSubscriptions,
  SINGLE_USER_CANCEL_BUDGET_MS,
  type AccountSubscriptionCancellation,
} from '@server/billing/cancelAccountSubscriptions';
import {
  purgeDeletedUserData,
  readUserIntegrationGrants,
  type UserIntegrationGrants,
} from '@server/services/purgeDeletedUserData';

export type HardDeleteInitiator = 'admin' | 'self';

export type HardDeleteContext = {
  /** Who the purge records as the deleter: the admin's id, or the user's own for a self-serve deletion. */
  deletedBy: string;
  /** Whose request this was, for the account_deleted analytics event. */
  initiatedBy: HardDeleteInitiator;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Runs inside the delete's transaction before the row goes; a throw aborts the delete. */
  assertInTransaction?: () => Promise<void>;
  /** Runs inside the delete's transaction after the row goes, so an audit entry commits or rolls back with it. */
  recordInTransaction?: (target: IUserDocument | null, cancellation: AccountSubscriptionCancellation) => Promise<void>;
  /** The delete's transaction failed after the subscription cancel, which cannot roll back. */
  onDeleteFailed?: (target: IUserDocument | null, cancellation: AccountSubscriptionCancellation) => Promise<void>;
};

/**
 * The account's own churn, for Overwatch: to the host, and to the product the user came through.
 * The occurrence is the pseudonym, never the raw id, which an eventId is sent verbatim beside.
 * Never throws: it runs in a `finally`, where a throw would replace the caller's own error.
 */
async function emitAccountDeleted(account: IUserDocument | null, initiatedBy: HardDeleteInitiator): Promise<void> {
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
 * and the self-serve deletion purge (server/users/completeAccountDeletion.ts).
 *
 * `commitDelete` runs the caller's own delete (its authorization and notifications) with a users
 * repository whose `delete` reads the integration grants and cancels the Stripe subscriptions first,
 * then deletes the row in a transaction with the context hooks. Once that commits, the purge and the
 * account_deleted event run in a `finally`: a throw after the commit (a failed notification) must not
 * skip them, because a retry would find no row and nothing would run them again.
 */
export async function hardDeleteUser<T>(
  userId: string,
  context: HardDeleteContext,
  commitDelete: (users: IUserRepository) => Promise<T>
): Promise<{ result: T; subscriptionCancellation: AccountSubscriptionCancellation | null }> {
  let deleteCommitted = false;
  let integrationGrants: UserIntegrationGrants | null = null;
  let deletedAccount: IUserDocument | null = null;
  let subscriptionCancellation: AccountSubscriptionCancellation | null = null;
  const users: IUserRepository = Object.create(userRepository, {
    delete: {
      value: async (id: string) => {
        // Captured right before the row goes: the purge needs them to revoke the provider grants,
        // and they are unreadable once the delete commits.
        integrationGrants = await readUserIntegrationGrants(id);
        const target = await userRepository.findById(id);
        deletedAccount = target;
        // Before the delete: the Stripe customer ids live on the row. A deleted account must never
        // renew, but a Stripe failure must not block the delete, so it is reported to the hooks instead.
        const cancellation = await cancelAccountSubscriptions(
          { userId: id, reason: 'account_deleted', deadline: Date.now() + SINGLE_USER_CANCEL_BUDGET_MS },
          context.logger
        );
        subscriptionCancellation = cancellation;
        let result: Awaited<ReturnType<typeof userRepository.delete>>;
        try {
          result = await withTransaction(async () => {
            await context.assertInTransaction?.();
            const deleted = await userRepository.delete(id);
            await context.recordInTransaction?.(target, cancellation);
            return deleted;
          });
        } catch (error) {
          // Best-effort: a failure here must not replace the delete's own error.
          try {
            await context.onDeleteFailed?.(target, cancellation);
          } catch (hookError) {
            context.logger.error(`onDeleteFailed hook failed for user ${id}: ${String(hookError)}`);
          }
          throw error;
        }
        deleteCommitted = true;
        return result;
      },
    },
  });

  try {
    const result = await commitDelete(users);
    return { result, subscriptionCancellation };
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
