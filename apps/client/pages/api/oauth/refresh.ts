import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { buildSessionDevice } from '@server/auth/sessionDevice';
import { isTokenVersionCurrent, authSessionService } from '@bike4mind/services';
import { User, userRepository, authSessionRepository } from '@bike4mind/database';
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

    const signAccessToken = (id: string, tokenVersion: number, extra?: Record<string, unknown>) =>
      authTokenGenerator.signAccessToken(id, tokenVersion, extra);

    try {
      // New session-store path: rotate the opaque refresh token against the AuthSession store.
      if (authSessionService.isOpaqueRefreshToken(refresh_token)) {
        const rotated = await authSessionService.rotateSession(refresh_token, {
          db: { authSessions: authSessionRepository, users: userRepository },
          signAccessToken,
          logger: req.logger,
        });
        return res.json({
          access_token: rotated.accessToken,
          refresh_token: rotated.refreshToken,
          token_type: 'Bearer',
          expires_in: 604800, // 7 days
        });
      }

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

      // Legacy JWT refresh token: lazily migrate onto a session. impersonatedBy is re-stamped so
      // an impersonated session keeps the marker across refresh (logout.ts's guard depends on it).
      const migrated = await authSessionService.issueSession(
        user.id,
        {
          createdVia: 'legacy-migration',
          tokenVersion: user.tokenVersion ?? 0,
          impersonatedBy: payload.impersonatedBy,
          device: buildSessionDevice(req),
        },
        { db: { authSessions: authSessionRepository }, signAccessToken, logger: req.logger }
      );

      return res.json({
        access_token: migrated.accessToken,
        refresh_token: migrated.refreshToken,
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
