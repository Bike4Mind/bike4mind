import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, userRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { EmailEvents } from '@server/utils/eventBus';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
import { toSafeUser, UnauthorizedError, type IUserDocument } from '@bike4mind/common';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';

const deletedUserTarget = (id: string, user: Pick<IUserDocument, 'name' | 'username' | 'email'> | null) => ({
  kind: 'user' as const,
  id,
  displayName: user?.name || user?.username || user?.email || id,
});

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

    if (!req.user.isAdmin) throw new UnauthorizedError('You are not authorized to delete users');
    if (isSelfOrImpersonator(req.user, userId)) {
      await denySelfAdminAction(req, {
        action: 'user.deletion.denied',
        attempted: 'user.deleted',
        target: deletedUserTarget(userId, await userRepository.findById(userId)),
      });
    }
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const deletedUser = await hardDeleteUser(
      userId,
      {
        deletedBy: String(req.user.id),
        initiatedBy: 'admin',
        logger: req.logger,
        // The delete and its audit entry commit together; cascades and notifications run after.
        recordInTransaction: async target => {
          await recordAdminActionFromRequest(req, {
            action: 'user.deleted',
            target: deletedUserTarget(userId, target),
            summary: 'deleted the user',
            reason,
          });
        },
      },
      users =>
        userService.adminDeleteUser(
          req.user.id,
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
              sendDeleteUserEmail: async (sendTo: string[], user: IUserDocument, admin: IUserDocument) => {
                await Promise.all(
                  sendTo.map(mailTo =>
                    EmailEvents.Send.publish({
                      to: mailTo,
                      subject: 'User Deletion Notification',
                      body: `
              <p>Admin user: ${escapeHtml(admin.name ?? '')} User deleted: *${escapeHtml(user.name ?? '')}* *${escapeHtml(user.email ?? '')}*</p>
              `,
                    })
                  )
                );
              },
            },
          }
        )
    );

    return res.json(toSafeUser(deletedUser));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
