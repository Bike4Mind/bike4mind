import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, embedConversationRepository, userRepository } from '@bike4mind/database';
import { postMessageToSlack } from '@server/integrations/slack/slack';
import { userService } from '@bike4mind/services';
import { IUserDocument } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';

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

    // Identified-embed history is keyed only by user id, so nothing else reaches it once the
    // account is gone. Best-effort: the user is already deleted, so a purge failure must not
    // turn this into a 500 a retry cannot fix; the collection's TTL index is the backstop.
    try {
      await embedConversationRepository.deleteAllForUser(userId);
    } catch (err) {
      req.logger.error(`Failed to purge embed conversations for deleted user ${userId}: ${String(err)}`);
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
