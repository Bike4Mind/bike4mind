import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { getTokens } from '@server/integrations/google/drive/common';
import { encryptToken } from '@server/security/tokenEncryption';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { code?: string }>(async (req, res) => {
    const { code } = req.query;
    const { user } = req;

    const tokens = await getTokens(code as string);
    await User.findByIdAndUpdate(user.id, {
      $set: {
        googleDrive: {
          accessToken: encryptToken(tokens.access_token!)!,
          refreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token)! : undefined,
          expiresAt: new Date(tokens.expiry_date!),
        },
      },
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
