import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import type { IUserDocument, IUserRepository } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';
import { purgeDeletedUserData } from '@server/services/purgeDeletedUserData';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

    // adminDeleteUser still sends notifications after the row is gone, and a throw there must not
    // skip the purge: a retry would 404, so nothing would run it again.
    let deleteCommitted = false;
    const users: IUserRepository = Object.create(userRepository, {
      delete: {
        value: async (id: string) => {
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
              <p>Admin user: ${admin.name} User deleted: *${user.name}* *${user.email}*</p>
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
        await purgeDeletedUserData(userId, { deletedBy: String(req.user.id), logger: req.logger });
      }
    }

    return res.json(deletedUser);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
