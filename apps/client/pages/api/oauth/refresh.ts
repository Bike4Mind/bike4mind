import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { isTokenVersionCurrent } from '@bike4mind/services';
import { User } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const RefreshRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  client_id: z.literal('b4m-cli'),
});

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 10,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const { refresh_token } = RefreshRequestSchema.parse(req.body);

    try {
      const payload = authTokenGenerator.verifyRefreshToken(refresh_token);

      if (!payload || !payload.userId) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      // Kill switch: load the user and reject a stale refresh token so a
      // revoked session can't be revived through the refresh endpoint.
      const user = await User.findById(payload.userId);
      if (!user || !isTokenVersionCurrent(payload.tokenVersion, user.tokenVersion)) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      const { accessToken, refreshToken } = authTokenGenerator.createAccessToken(user.id, user.tokenVersion ?? 0);

      return res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: 'Bearer',
        expires_in: 604800, // 7 days
      });
    } catch (error) {
      console.error('Token refresh error:', error);

      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired refresh token',
      });
    }
  });

export default handler;
