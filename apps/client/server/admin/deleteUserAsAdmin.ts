import { resolveRoleAdminPermissions } from '@bike4mind/server-utils/auth/adminRoles';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  assertCanActOnAdminTarget,
  canAccessAdmin,
  escapeSlackLine,
  hasAdminPermission,
  isFullAdmin,
  type AdminApproval,
  type IUserDocument,
} from '@bike4mind/common';
import { z } from 'zod';
import type { Request } from 'express';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { subscriptionCancellationAudit } from '@bike4mind/server-utils/billing/cancelAccountSubscriptions';
import { approvalDetails } from '@server/admin/creditGrants/approval';
import { requestAdminErasure } from '@server/users/accountDeletion';

export const deletedUserTarget = (id: string, user: Pick<IUserDocument, 'name' | 'username' | 'email'> | null) => ({
  kind: 'user' as const,
  id,
  displayName: user?.name || user?.username || user?.email || id,
});

/**
 * Erases `userId` as `req.user`; shared by the delete route and the approved `user.delete_admin` executor.
 * Stamps an immediate admin erasure (the lockdown, the `user.deleted` audit entry and the target role
 * re-checks commit together) and queues the account purge, which resumes under a lease if a step fails;
 * the daily deletion sweep is the backstop when the queue is unreachable.
 */
export async function deleteUserAsAdmin(
  req: Request,
  userId: string,
  reason: string,
  approval?: AdminApproval,
  options: { requireNonAdmin?: boolean } = {}
) {
  const admin = req.user!;
  const stored = await userRepository.findById(String(admin.id));
  const actor = stored ? await resolveRoleAdminPermissions(stored) : null;
  if (!actor || !hasAdminPermission(actor, 'users:delete')) {
    throw new UnauthorizedError('You are not authorized to delete users');
  }
  const target = await userRepository.findById(userId);
  if (!target) throw new NotFoundError(`User ${userId} not found`);
  assertCanActOnAdminTarget(actor, target, 'delete');

  const canonicalUserId = target.id;

  const { subscriptions } = await requestAdminErasure(req, canonicalUserId, new Date(), {
    recordInTransaction: async () => {
      // A changed role aborts the stamp before any credentials are revoked or subscriptions canceled.
      if (approval) await assertStillAdmin(canonicalUserId);
      else if (options.requireNonAdmin && canAccessAdmin(await userRepository.findById(canonicalUserId))) {
        throw new ConflictError(
          isFullAdmin(admin)
            ? 'This user now has admin access; request the deletion again for approval.'
            : 'This user now has admin access; only a full administrator can delete it.'
        );
      }
      const details = approvalDetails(approval);
      await recordAdminActionFromRequest(req, {
        action: 'user.deleted',
        target: deletedUserTarget(canonicalUserId, target),
        summary: 'deleted the user',
        reason,
        ...(Object.keys(details).length > 0 && { details }),
      });
    },
  });

  // The stamp has committed; everything below is best-effort and never fails the request.
  const canceledEntry = subscriptionCancellationAudit(subscriptions, 'account_deleted');
  if (canceledEntry) {
    await recordAdminActionFromRequest(req, {
      ...canceledEntry,
      target: deletedUserTarget(canonicalUserId, target),
      reason,
      ...(approval && { details: { ...canceledEntry.details, ...approvalDetails(approval) } }),
    }).catch(error =>
      req.logger.error(`Failed to audit the subscription cancellation for user ${canonicalUserId}`, { error })
    );
  }
  await notifyDeletion(req, admin, target);

  let queued = true;
  try {
    await sendToQueue(getSourceQueueUrl('accountErasureQueue'), { userId: canonicalUserId });
  } catch (error) {
    queued = false;
    req.logger.error(
      `Failed to queue the erasure of user ${canonicalUserId}; the daily sweep will run it: ${String(error)}`
    );
  }
  return { user: target, subscriptionCancellation: subscriptions, queued };
}

/** Slack and email notices, gated by the admin settings; sent while the name and email still exist. */
async function notifyDeletion(req: Request, admin: NonNullable<Request['user']>, user: IUserDocument) {
  try {
    const [slack, email] = await adminSettingsRepository.findBySettingNames([
      'EnableUserDeletionSlackNotification',
      'EnableUserDeletionEmailNotification',
    ]);
    if (slack) {
      await postMessageToSlack(
        `Admin user: ${admin.id} User deleted: *${escapeSlackLine(user.name ?? '')}* *${escapeSlackLine(user.email ?? '')}*`
      );
    }
    if (email) {
      const feedbackEmails = (await adminSettingsRepository.findAllByTag('feedbackEmail')).map(s => s.settingValue);
      await Promise.all(
        feedbackEmails.map(to =>
          EmailEvents.Send.publish({
            to,
            subject: 'User Deletion Notification',
            body: `<p>Admin user: ${escapeHtml(admin.name ?? '')} User deleted: *${escapeHtml(user.name ?? '')}* *${escapeHtml(user.email ?? '')}*</p>`,
          })
        )
      );
    }
  } catch (error) {
    req.logger.error(`Failed to send the deletion notifications for user ${user.id}`, { error });
  }
}

export const DeleteAdminParamsSchema = z.object({ userId: z.string().min(1), reason: z.string() });
export type DeleteAdminParams = z.infer<typeof DeleteAdminParamsSchema>;

/** Runs an approved `user.delete_admin` as the approver, who must not be deleting themselves. */
export async function executeApprovedAdminDelete(req: Request, params: DeleteAdminParams, approval: AdminApproval) {
  if (isSelfOrImpersonator(req.user!, params.userId)) {
    throw new ForbiddenError('Admins cannot delete their own account.');
  }
  // Early fail only; the stamp transaction re-checks the role.
  await assertStillAdmin(params.userId);
  const { user } = await deleteUserAsAdmin(req, params.userId, params.reason, approval);
  return { deletedUserId: user.id };
}

// Approval was only required because the target was an admin; one demoted since then is no longer what was approved.
async function assertStillAdmin(userId: string) {
  if (!canAccessAdmin(await userRepository.findById(userId))) {
    throw new ConflictError('This user is no longer an admin; request the deletion again.');
  }
}
