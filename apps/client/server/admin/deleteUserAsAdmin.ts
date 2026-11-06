import { adminSettingsRepository, realtimeConnectionRepository, userRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import {
  ConflictError,
  ForbiddenError,
  canAccessAdmin,
  type AdminApproval,
  type IUserDocument,
} from '@bike4mind/common';
import { z } from 'zod';
import type { Request } from 'express';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { EmailEvents } from '@server/utils/eventBus';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { subscriptionCancellationAudit } from '@server/billing/cancelAccountSubscriptions';
import { approvalDetails } from '@server/admin/creditGrants/approval';

export const deletedUserTarget = (id: string, user: Pick<IUserDocument, 'name' | 'username' | 'email'> | null) => ({
  kind: 'user' as const,
  id,
  displayName: user?.name || user?.username || user?.email || id,
});

/** Hard-deletes `userId` as `req.user`; shared by the delete route and the approved `user.delete_admin` executor. */
export async function deleteUserAsAdmin(
  req: Request,
  userId: string,
  reason: string,
  approval?: AdminApproval,
  onDeleteCommitted?: () => void
) {
  const admin = req.user!;
  return hardDeleteUser(
    userId,
    {
      deletedBy: String(admin.id),
      initiatedBy: 'admin',
      logger: req.logger,
      onDeleteCommitted,
      // An approved delete re-reads the target in the delete's transaction, so a demotion racing it aborts it.
      ...(approval && { assertInTransaction: () => assertStillAdmin(userId) }),
      // The delete and its audit entry commit together; cascades and notifications run after.
      recordInTransaction: async (target, cancellation) => {
        const canceledEntry = subscriptionCancellationAudit(cancellation, 'account_deleted');
        const details = { ...canceledEntry?.details, ...approvalDetails(approval) };
        await recordAdminActionFromRequest(req, {
          action: 'user.deleted',
          target: deletedUserTarget(userId, target),
          summary: canceledEntry ? `deleted the user; ${canceledEntry.summary}` : 'deleted the user',
          reason,
          ...(Object.keys(details).length > 0 && { details }),
        });
      },
      // The cancel already happened and cannot roll back, so record it on its own (best-effort).
      onDeleteFailed: async (target, cancellation) => {
        const canceledEntry = subscriptionCancellationAudit(cancellation, 'account_deleted');
        if (canceledEntry) {
          await recordAdminActionFromRequest(req, {
            ...canceledEntry,
            target: deletedUserTarget(userId, target),
            reason,
            ...(approval && { details: { ...canceledEntry.details, ...approvalDetails(approval) } }),
          });
        }
      },
    },
    users =>
      userService.adminDeleteUser(
        admin.id,
        { id: userId },
        {
          db: {
            users,
            adminSettings: adminSettingsRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
          notify: {
            // postMessageToSlack reports whether it delivered; the adapter contract returns void.
            send: async (message: string) => {
              await postMessageToSlack(message);
            },
          },
          mailer: {
            sendDeleteUserEmail: async (sendTo: string[], user: IUserDocument, adminUser: IUserDocument) => {
              await Promise.all(
                sendTo.map(mailTo =>
                  EmailEvents.Send.publish({
                    to: mailTo,
                    subject: 'User Deletion Notification',
                    body: `
              <p>Admin user: ${escapeHtml(adminUser.name ?? '')} User deleted: *${escapeHtml(user.name ?? '')}* *${escapeHtml(user.email ?? '')}*</p>
              `,
                  })
                )
              );
            },
          },
        }
      )
  );
}

export const DeleteAdminParamsSchema = z.object({ userId: z.string().min(1), reason: z.string() });
export type DeleteAdminParams = z.infer<typeof DeleteAdminParamsSchema>;

/** Runs an approved `user.delete_admin` as the approver, who must not be deleting themselves. */
export async function executeApprovedAdminDelete(req: Request, params: DeleteAdminParams, approval: AdminApproval) {
  if (isSelfOrImpersonator(req.user!, params.userId)) {
    throw new ForbiddenError('Admins cannot delete their own account.');
  }
  // Early fail only; hardDeleteUser re-checks right before the subscription cancel and again in the transaction.
  await assertStillAdmin(params.userId);
  let committed = false;
  try {
    await deleteUserAsAdmin(req, params.userId, params.reason, approval, () => {
      committed = true;
    });
  } catch (error) {
    // Notifications and cleanup run after the delete commits; once it has committed the approved action ran.
    if (!committed) throw error;
    req.logger.error('[ADMIN_APPROVAL_DELETE_AFTER_COMMIT_FAILED]', { approvalId: approval.id, error });
  }
  return { deletedUserId: params.userId };
}

// Approval was only required because the target was an admin; one demoted since then is no longer what was approved.
async function assertStillAdmin(userId: string) {
  if (!canAccessAdmin(await userRepository.findById(userId))) {
    throw new ConflictError('This user is no longer an admin; request the deletion again.');
  }
}
