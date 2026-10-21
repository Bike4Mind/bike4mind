import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  adminSettingsRepository,
  userRepository,
  realtimeConnectionRepository,
  withTransaction,
} from '@bike4mind/database';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { EmailEvents } from '@server/utils/eventBus';
import {
  purgeDeletedUserData,
  readUserIntegrationGrants,
  type UserIntegrationGrants,
} from '@server/services/purgeDeletedUserData';
import { toSafeUser, UnauthorizedError, type IUserDocument, type IUserRepository } from '@bike4mind/common';
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

    // adminDeleteUser still sends notifications after the row is gone, and a throw there must not
    // skip the purge: a retry would 404, so nothing would run it again.
    let deleteCommitted = false;
    let integrationGrants: UserIntegrationGrants | null = null;
    const users: IUserRepository = Object.create(userRepository, {
      delete: {
        value: async (id: string) => {
          // Captured here, right before the row goes, because the purge below needs them to revoke the
          // provider grants and they are unreadable once the delete commits.
          integrationGrants = await readUserIntegrationGrants(id);
          const target = await userRepository.findById(id);
          // The delete and its audit entry commit together; cascades and notifications run after.
          const result = await withTransaction(async () => {
            const deleted = await userRepository.delete(id);
            await recordAdminActionFromRequest(req, {
              action: 'user.deleted',
              target: deletedUserTarget(id, target),
              summary: 'deleted the user',
              reason,
            });
            return deleted;
          });
          deleteCommitted = true;
          return result;
        },
      },
    });

    let deletedUser: IUserDocument;
    try {
      deletedUser = await userService.adminDeleteUser(
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
      );
    } finally {
      // Runs only once adminDeleteUser has authorized and committed the delete. Best-effort
      // inside, so it never turns this into a 500 a retry cannot fix.
      if (deleteCommitted) {
        await purgeDeletedUserData(userId, {
          deletedBy: String(req.user.id),
          logger: req.logger,
          integrationGrants,
        });
      }
    }

    return res.json(toSafeUser(deletedUser));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
