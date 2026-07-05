import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { UserApiKeyEvents } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError } from '@server/utils/errors';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const keyId = req.query.id;

    if (!keyId) throw new BadRequestError('Invalid key ID');

    const rotatedKey = await userApiKeyService.rotateUserApiKey(
      userId,
      { keyId },
      {
        db: {
          userApiKeys: userApiKeyRepository,
        },
      }
    );

    await logEvent(
      {
        userId,
        type: UserApiKeyEvents.ROTATED,
        metadata: {
          keyId,
          name: rotatedKey.name,
        },
      },
      { ability: req.ability }
    );

    return res.status(200).json(rotatedKey);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
