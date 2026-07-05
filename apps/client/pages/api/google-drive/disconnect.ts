import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import dayjs from 'dayjs';
import { revokeToken } from '@server/integrations/google/drive/common';

const handler = baseApi().delete(
  asyncHandler(async (req, res) => {
    const googleDrive = req.user.googleDrive;
    if (!googleDrive) {
      throw new BadRequestError('You do not have Google Drive connected');
    }

    const isAccessTokenExpired = !googleDrive.expiresAt || dayjs().isAfter(dayjs(googleDrive.expiresAt));

    if (!isAccessTokenExpired) {
      await revokeToken(googleDrive.accessToken);
    }

    await User.findByIdAndUpdate(req.user.id, {
      googleDrive: null,
    });

    return res.status(204).send();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
