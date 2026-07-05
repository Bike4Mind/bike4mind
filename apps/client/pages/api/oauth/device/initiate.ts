import { deviceAuthorizationRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { generateDeviceCode, generateUserCode, hashDeviceCode } from '@server/utils/oauth/deviceAuthHelpers';
import { z } from 'zod';

const InitiateRequestSchema = z.object({
  client_id: z.literal('b4m-cli'),
});

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 5,
      windowMs: 60 * 60 * 1000, // 1 hour window
    })
  )
  .post(async (req, res) => {
    InitiateRequestSchema.parse(req.body);

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();

    const hashedDeviceCode = await hashDeviceCode(deviceCode);

    await deviceAuthorizationRepository.create({
      deviceCode: hashedDeviceCode,
      userCode,
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

    const baseUrl = process.env.APP_URL?.includes('localhost')
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
