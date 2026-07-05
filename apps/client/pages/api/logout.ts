import { AuthEvents, IUserDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const userId = (req.user as IUserDocument)?.id;

  await userService.updateLogoutTime(userId, { db: { users: userRepository }, logger: req.logger });
  await logEvent({ userId, type: AuthEvents.LOGOUT }, { ability: req.ability });
  if (userId) await logAuthAudit(req, { userId, event: 'logout' });
  return res.status(200).json({ message: 'Logged out' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
