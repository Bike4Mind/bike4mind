import { cacheRepository, deviceAuthorizationRepository, digestDeviceCode } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import {
  generateDeviceCode,
  generateUserCode,
  LIVE_PENDING_COUNTER_KEY,
  MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS,
} from '@server/utils/oauth/deviceAuthHelpers';
import { z } from 'zod';
import { isLocalAppUrl } from '@server/utils/validators';
import { OAUTH_DEVICE_CLIENT_IDS } from '@bike4mind/common';

const InitiateRequestSchema = z.object({
  client_id: z.enum(OAUTH_DEVICE_CLIENT_IDS),
});

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 60 * 1000, // 1 hour window
    })
  )
  .post(async (req, res) => {
    const { client_id: clientId } = InitiateRequestSchema.parse(req.body);

    // Global, not per-IP: IP headers are spoofable when the origin is reached directly.
    // Sliding-window TTL of 30 min (3x the 10-min auth TTL) keeps the key alive under sustained
    // load and self-heals once all pending docs have been resolved or TTL-expired.
    let { success: slotGranted } = await cacheRepository.incrementCounterConditional(
      LIVE_PENDING_COUNTER_KEY,
      MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS,
      30 * 60_000
    );

    if (!slotGranted) {
      // Counter may have drifted high from pending docs that expired without going through verify.
      // Read the authoritative DB count, overwrite the cache, and retry once before refusing.
      const trueCount = await deviceAuthorizationRepository.countPendingAndUnexpired();
      if (trueCount < MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS) {
        await cacheRepository.createOrUpdate({
          key: LIVE_PENDING_COUNTER_KEY,
          result: { count: trueCount },
          expiresAt: new Date(Date.now() + 30 * 60_000),
        });
        ({ success: slotGranted } = await cacheRepository.incrementCounterConditional(
          LIVE_PENDING_COUNTER_KEY,
          MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS,
          30 * 60_000
        ));
      }
    }

    if (!slotGranted) {
      req.logger.warn(
        `[OAUTH_DEVICE_INITIATE] pending device authorization cap reached (${MAX_LIVE_PENDING_DEVICE_AUTHORIZATIONS}); returning 503`
      );
      res.setHeader('Retry-After', 60);
      return res.status(503).json({
        error: 'temporarily_unavailable',
        error_description: 'Too many pending device authorizations, try again later',
      });
    }

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();

    await deviceAuthorizationRepository.create({
      deviceCode: digestDeviceCode(deviceCode),
      userCode,
      clientId,
      status: 'pending',
      userId: null,
      expiresAt: new Date(Date.now() + 600000), // 10 minutes
      approvedAt: null,
      lastPolledAt: null,
      ipAddress: req.socket.remoteAddress || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      pollCount: 0,
      verificationAttempts: 0,
    });

    const baseUrl = isLocalAppUrl()
      ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}`
      : process.env.APP_URL || 'http://localhost:3000';

    return res.json({
      device_code: deviceCode, // raw, not hashed (storage holds the hash)
      user_code: userCode,
      verification_uri: `${baseUrl}/activate`,
      verification_uri_complete: `${baseUrl}/activate?code=${userCode}`,
      expires_in: 600,
      interval: 5,
    });
  });

export default handler;
