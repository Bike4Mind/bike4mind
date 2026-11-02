import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_ORG_TRANSFER_REQUIRED,
  ConflictError,
  NotFoundError,
  accountDeletionDueAt,
  type IUserDocument,
} from '@bike4mind/common';
import { authSessionRepository, realtimeConnectionRepository, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { revokeAppleTokens } from '@bike4mind/server-utils/auth/revokeAppleTokens';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { cancelAccountSubscriptions } from '@server/billing/cancelAccountSubscriptions';
import { EmailEvents } from '@server/utils/eventBus';
import { classifyOwnedOrganizations } from './ownedOrganizations';

type DeletionLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

export type AccountDeletionRequestResult = {
  deletionRequestedAt: Date;
  deletionScheduledFor: Date;
  /** False when the account was already pending: the grace period keeps its original start. */
  newlyRequested: boolean;
  canceledSubscriptions: string[];
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Best-effort: Apple's token revocation is required of us, but a provider outage must not block the deletion. */
async function revokeAppleGrant(userId: string, logger: DeletionLogger): Promise<void> {
  try {
    const result = await revokeAppleTokens(userId);
    if (result.status === 'revoked') logger.info(`[AccountDeletion] Revoked the Apple grant of user ${userId}`);
    if (result.status === 'not_configured') {
      logger.warn(`[AccountDeletion] User ${userId} has an Apple token, but Apple is not configured to revoke it`);
    }
  } catch (error) {
    logger.error(`[AccountDeletion] Failed to revoke the Apple grant of user ${userId}: ${errorMessage(error)}`);
  }
}

async function sendDeletionRequestedEmail(user: IUserDocument, scheduledFor: Date, logger: DeletionLogger) {
  if (!user.email) return;
  const name = escapeHtml(user.name || user.username || '');
  const when = scheduledFor.toUTCString();
  try {
    await EmailEvents.Send.publish({
      to: user.email,
      subject: 'Your account is scheduled for deletion',
      body: `
        <p>Hi ${name},</p>
        <p>We received a request to delete your account. You have been signed out on every device and any
        active subscription has been canceled.</p>
        <p>Your account and its data will be permanently deleted on <strong>${escapeHtml(when)}</strong>
        (${ACCOUNT_DELETION_GRACE_DAYS} days from your request). Until then you can sign in and restore it.</p>
        <p>If you did not ask for this, sign in now and restore your account, then change your password.</p>
      `,
    });
  } catch (error) {
    logger.error(`[AccountDeletion] Failed to send the confirmation email to user ${user.id}: ${errorMessage(error)}`);
  }
}

/**
 * Self-service account deletion request (DELETE /api/users/me). Marks the account deletion-pending, then
 * signs it out everywhere, cancels its Stripe subscriptions immediately, revokes its Apple grant and mails
 * a confirmation. The hard delete happens after the grace period (apps/workers/src/cron/accountDeletionSweep.ts).
 *
 * Idempotent: a repeat keeps the original request time and sends no second email, but re-runs the
 * revocations, so a request interrupted after the mark converges on the next try. Refused with a 409 while
 * the user owns an organization anyone else belongs to.
 */
export async function requestAccountDeletion(
  userId: string,
  { logger, now = new Date() }: { logger: DeletionLogger; now?: Date }
): Promise<AccountDeletionRequestResult> {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const { shared } = await classifyOwnedOrganizations(userId);
  if (shared.length > 0) {
    throw new ConflictError(
      'Transfer ownership of your organizations, or remove their other members, before deleting your account.',
      {
        code: ACCOUNT_DELETION_ORG_TRANSFER_REQUIRED,
        organizations: shared.map(org => ({ id: org.id, name: org.name })),
      }
    );
  }

  const marked = await userRepository.markDeletionRequested(userId, now);
  if (!marked) throw new NotFoundError('User not found');
  const deletionScheduledFor = accountDeletionDueAt(marked.deletionRequestedAt);

  // The tokenVersion bump plus the session revoke: every device, this one included, is signed out.
  await userService.revokeUserSessions(userId, {
    db: {
      users: userRepository,
      authSessions: authSessionRepository,
      realtimeConnections: realtimeConnectionRepository,
    },
  });

  const { canceled } = await cancelAccountSubscriptions({ userId, reason: 'account_deletion_requested' }, logger);
  await revokeAppleGrant(userId, logger);

  if (marked.newlyMarked) {
    logger.info(
      `[AccountDeletion] User ${userId} requested deletion; scheduled for ${deletionScheduledFor.toISOString()}`
    );
    await sendDeletionRequestedEmail(user, deletionScheduledFor, logger);
  }

  return {
    deletionRequestedAt: marked.deletionRequestedAt,
    deletionScheduledFor,
    newlyRequested: marked.newlyMarked,
    canceledSubscriptions: canceled,
  };
}
