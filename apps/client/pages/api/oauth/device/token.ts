import { deviceAuthorizationRepository, userRepository } from '@bike4mind/database';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';

const TokenRequestSchema = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
  device_code: z.string(),
  client_id: z.literal('b4m-cli'),
});

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 20,
      windowMs: 60 * 1000, // 1 minute window (allows polling every 5 seconds with buffer)
    })
  )
  .post(async (req, res) => {
    const { device_code } = TokenRequestSchema.parse(req.body);

    const authorization = await deviceAuthorizationRepository.findByDeviceCode(device_code);

    if (!authorization) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid device code',
      });
    }

    if (new Date() > authorization.expiresAt) {
      return res.status(400).json({
        error: 'expired_token',
        error_description: 'Device code has expired',
      });
    }

    if (authorization.lastPolledAt) {
      const timeSinceLastPoll = Date.now() - authorization.lastPolledAt.getTime();
      if (timeSinceLastPoll < 5000) {
        return res.status(400).json({
          error: 'slow_down',
          error_description: 'Polling too frequently, wait at least 5 seconds',
        });
      }
    }

    await deviceAuthorizationRepository.update({
      id: authorization.id,
      pollCount: authorization.pollCount + 1,
      lastPolledAt: new Date(),
    });

    switch (authorization.status) {
      case 'pending':
        return res.status(400).json({
          error: 'authorization_pending',
          error_description: 'User has not yet approved the request',
        });

      case 'denied':
        return res.status(403).json({
          error: 'access_denied',
          error_description: 'User denied the authorization request',
        });

      case 'approved': {
        if (!authorization.userId) {
          throw new BadRequestError('Authorization approved but userId is missing');
        }

        // Load the user so the issued token carries the current tokenVersion;
        // a token minted with a stale version would be rejected immediately.
        const authorizedUser = await userRepository.findById(authorization.userId);
        if (!authorizedUser) {
          throw new BadRequestError('Authorization approved but user no longer exists');
        }

        // same token service used for regular login
        const { accessToken, refreshToken } = authTokenGenerator.createAccessToken(
          authorizedUser.id,
          authorizedUser.tokenVersion ?? 0
        );

        // mark consumed to prevent token reuse
        await deviceAuthorizationRepository.update({
          id: authorization.id,
          status: 'consumed',
        });

        return res.json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: 604800, // 7 days
        });
      }

      default:
        return res.status(400).json({
          error: 'invalid_grant',
          error_description: 'Invalid authorization status',
        });
    }
  });

export default handler;
