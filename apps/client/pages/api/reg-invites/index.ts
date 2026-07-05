import { registrationInviteRepository } from '@bike4mind/database/auth';
import { referService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const user = req.user;

    const results = await referService.listRegInvites(user, { db: { regInvites: registrationInviteRepository } });
    return res.status(200).json(results);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
