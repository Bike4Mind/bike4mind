import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, userRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import { escapeHtml } from '@client/app/utils/htmlEscape';
import { EmailEvents } from '@server/utils/eventBus';
import {
  purgeDeletedUserData,
  readUserIntegrationGrants,
  type UserIntegrationGrants,
} from '@server/services/purgeDeletedUserData';
import { toSafeUser, type IUserDocument, type IUserRepository } from '@bike4mind/common';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

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
          const result = await userRepository.delete(id);
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
            send: postMessageToSlack,
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
