import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, userRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import { IUserDocument } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';
import { purgeDeletedUserData } from '@server/services/purgeDeletedUserData';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;

    const deletedUser = await userService.adminDeleteUser(
      req.user.id,
      { id: userId },
      {
        db: {
          users: userRepository,
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

    // Runs only after adminDeleteUser has authorized and committed the delete. Best-effort
    // inside, so it never turns this into a 500 a retry cannot fix.
    await purgeDeletedUserData(userId, { deletedBy: String(req.user.id), logger: req.logger });

    return res.json(deletedUser);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
