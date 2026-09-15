import { referService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { RegInviteEvents } from '@bike4mind/common';
import { registrationInviteRepository } from '@bike4mind/database';

const handler = baseApi().post(
  asyncHandler<unknown, unknown, { ids: string[] }>(async (req, res) => {
    const user = req.user;
    const ids = req.body.ids;

    await referService.deleteInviteCodes(user, { ids }, { db: { regInvites: registrationInviteRepository } });

    await logEvent(
      { userId: user.id, type: RegInviteEvents.DELETE_REGINVITE, metadata: { ids } },
      { ability: req.ability }
    );

    return res.status(200).send();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
