import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { cacheRepository, deviceAuthorizationRepository, DeviceAuthorizationModel } from '@bike4mind/database';
import { z } from 'zod';
import { LEGACY_DEVICE_CLIENT_ID, oauthClientDisplayName } from '@bike4mind/common';
import { LIVE_PENDING_COUNTER_KEY } from '@server/utils/oauth/deviceAuthHelpers';
import {
  CLI_ACCESS_DENIED_MESSAGE,
  SUBSCRIPTION_REQUIRED_ERROR,
  isApiKeyAccessAllowed,
} from '@server/utils/apiKeyAccessGate';

const VerifyRequestSchema = z.object({
  user_code: z.string(),
  action: z.enum(['approve', 'deny']),
});

// jwtOnly: approving a device code grants the device a full session, so an API key must never act
// as the user here (see sessionGrantRoutesRejectApiKeys.test.ts).
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: 10,
      windowMs: 60 * 1000, // 1 minute window
    })
  )
  .post(async (req, res) => {
    const { user_code, action } = VerifyRequestSchema.parse(req.body);
    const userId = req.user?.id;

    if (!userId || !req.user) {
      return res.status(401).json({
        error: 'unauthorized',
        error_description: 'Must be logged in',
      });
    }

    const authorization = await deviceAuthorizationRepository.findByUserCode(user_code);

    if (!authorization) {
      return res.status(404).json({
        error: 'invalid_code',
        error_description: 'Code not found or expired',
      });
    }

    if (authorization.verificationAttempts >= 10) {
      return res.status(429).json({
        error: 'too_many_attempts',
        error_description: 'Too many verification attempts',
      });
    }

    // The admin paid-only switch: the device flow only serves the CLI and desktop app.
    if (action === 'approve' && req.user && !(await isApiKeyAccessAllowed(req.user, undefined, req))) {
      return res.status(403).json({ error: SUBSCRIPTION_REQUIRED_ERROR, error_description: CLI_ACCESS_DENIED_MESSAGE });
    }

    // direct model update: BaseRepository.update() strips userId to avoid path
    // ambiguity with ShareableDocumentSchema, but DeviceAuthorization needs it set here.
    // findOneAndUpdate with status:'pending' guard is atomic: a concurrent verify of the
    // same user_code will see status:'approved'/'denied' and get null back, skipping the
    // decrement and preventing a double-decrement. findByIdAndUpdate cannot carry extra
    // filter fields -- Mongoose drops everything but _id.
    const transitioned = await DeviceAuthorizationModel.findOneAndUpdate(
      { _id: authorization.id, status: 'pending' },
      {
        $set: {
          status: action === 'approve' ? 'approved' : 'denied',
          userId: action === 'approve' ? userId : null,
          approvedAt: action === 'approve' ? new Date() : null,
          verificationAttempts: authorization.verificationAttempts + 1,
        },
      },
      { new: false }
    );

    if (transitioned) {
      await cacheRepository.decrementCounter(LIVE_PENDING_COUNTER_KEY);
    }

    // TODO: Add audit logging for security

    const clientId = authorization.clientId ?? LEGACY_DEVICE_CLIENT_ID;

    return res.json({
      success: true,
      device_info: {
        client_type: clientId,
        client_name: oauthClientDisplayName(clientId),
        ip_address: authorization.ipAddress,
        created_at: authorization.createdAt.toISOString(),
      },
    });
  });

export default handler;
