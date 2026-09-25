import { deviceAuthorizationRepository, digestDeviceCode } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { generateDeviceCode, generateUserCode } from '@server/utils/oauth/deviceAuthHelpers';
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
