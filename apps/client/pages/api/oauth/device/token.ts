import { cacheRepository, deviceAuthorizationRepository, userRepository } from '@bike4mind/database';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { ACCESS_TOKEN_TTL_SECONDS } from '@server/auth/tokenGenerator';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS } from '@server/utils/oauth/deviceAuthHelpers';
import { BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import { LEGACY_DEVICE_CLIENT_ID, OAUTH_DEVICE_CLIENT_IDS } from '@bike4mind/common';

const TokenRequestSchema = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
  device_code: z.string(),
  client_id: z.enum(OAUTH_DEVICE_CLIENT_IDS),
});

const TOKEN_GLOBAL_KEY = 'rate-limit:device-token-global';
const TOKEN_GLOBAL_LIMIT_PER_MIN = MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS * 12;

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 20,
      windowMs: 60 * 1000, // 1 minute window (allows polling every 5 seconds with buffer)
    })
  )
  .post(async (req, res) => {
    const { device_code, client_id } = TokenRequestSchema.parse(req.body);

    // Keyed on nothing caller-controlled: IP headers and device_code are both rotatable.
    // Answered with slow_down rather than 429 so the CLI backs off instead of aborting the login.
    const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      TOKEN_GLOBAL_KEY,
      TOKEN_GLOBAL_LIMIT_PER_MIN,
      60_000
    );
    if (!success) {
      req.logger.warn(
        `[OAUTH_DEVICE_TOKEN] global poll ceiling reached (${TOKEN_GLOBAL_LIMIT_PER_MIN}/min); returning slow_down`
      );
      return res.status(400).json({
        error: 'slow_down',
        error_description: 'Too many device token requests, slow down',
      });
    }

    const authorization = await deviceAuthorizationRepository.findByDeviceCode(device_code);

    if (!authorization) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Invalid device code',
      });
    }

    // RFC 8628 s3.4: the code may only be redeemed by the client it was issued to. Consent is
    // given for one app, so letting another redeem the code would spend it on something the user
    // did not approve. Checked before any poll bookkeeping so a mismatched client advances no state.
    if ((authorization.clientId ?? LEGACY_DEVICE_CLIENT_ID) !== client_id) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_description: 'Device code was issued to a different client',
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

        // same session service used for regular login
        const { accessToken, refreshToken } = await issueSessionForRequest(req, authorizedUser.id, {
          createdVia: 'device',
          tokenVersion: authorizedUser.tokenVersion ?? 0,
        });

        // mark consumed to prevent token reuse
        await deviceAuthorizationRepository.update({
          id: authorization.id,
          status: 'consumed',
        });

        return res.json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
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
