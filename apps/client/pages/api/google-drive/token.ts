import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import dayjs from 'dayjs';
import { getAuthUrl, refreshAccessToken } from '@server/integrations/google/drive/common';
import { encryptToken, decryptToken } from '@server/security/tokenEncryption';

/**
 * Hand the browser the caller's live Google Drive access token, refreshing it first
 * when it has expired.
 *
 * `auth: 'jwtOnly'` keeps this OFF the api-key surface, matching the sibling
 * `list-folder.ts`: the response body *is* a third-party OAuth credential, so an
 * unrelated `b4m_live_` key must not be able to fetch or silently refresh it. It is
 * an internal/UI surface, not a public contract endpoint, so a key-bearing request is
 * rejected outright.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const user = await User.findById(userId, 'googleDrive');

    if (!user) throw new NotFoundError('User not found');
    if (!user.googleDrive) throw new BadRequestError('Google Drive not connected');

    const { accessToken: rawAccessToken, refreshToken: rawRefreshToken, expiresAt } = user.googleDrive;
    const accessToken = decryptToken(rawAccessToken);
    const refreshToken = decryptToken(rawRefreshToken);

    // Check if the access token is still valid
    const isAccessTokenExpired = !expiresAt || dayjs().isAfter(dayjs(expiresAt));

    // If the access token is still valid, return it
    if (!isAccessTokenExpired) {
      console.log('using existing access token...');
      return res.json({ accessToken });
    }

    // If the access token is expired, refresh it
    try {
      console.log('refreshing access token...');
      if (!refreshToken) throw new BadRequestError('Refresh token not found');
      const credentials = await refreshAccessToken(refreshToken);
      await User.updateOne(
        { _id: userId },
        {
          'googleDrive.accessToken': encryptToken(credentials.access_token!)!,
          'googleDrive.refreshToken': credentials.refresh_token
            ? encryptToken(credentials.refresh_token)!
            : rawRefreshToken,
          'googleDrive.expiresAt': new Date(credentials.expiry_date!),
        }
      );
      return res.json({ accessToken: credentials.access_token });
    } catch (error) {
      const authUrl = getAuthUrl();
      return res.json({ authUrl });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
