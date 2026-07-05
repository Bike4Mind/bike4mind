import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { reason?: string }, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const keyId = req.query.id;
    const { reason } = req.body;

    if (!keyId) throw new BadRequestError('Invalid key ID');

    await userApiKeyService.revokeUserApiKey(
      userId,
      { keyId, reason },
      {
        db: {
          userApiKeys: userApiKeyRepository,
        },
      }
    );

    await logEvent(
      {
        userId,
        type: UserApiKeyEvents.REVOKED,
        metadata: {
          keyId,
          name: 'Unknown', // We could fetch this if needed
          reason,
        },
      },
      { ability: req.ability }
    );

    return res.status(200).json({ success: true });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
