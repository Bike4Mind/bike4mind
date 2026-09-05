import { userApiKeyService } from '@bike4mind/services';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { organizationRepository } from '@bike4mind/database';
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
          organizations: organizationRepository,
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
          // Present only when an org admin rotated someone else's key: the rotation
          // re-owned it, so this is the audit trail for the change of hands.
          ...(rotatedKey.previousOwnerUserId ? { previousOwnerUserId: rotatedKey.previousOwnerUserId } : {}),
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
