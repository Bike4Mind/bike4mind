import { apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { BadRequestError } from '@server/utils/errors';
import { ApiKeyEvents } from '@bike4mind/common';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const id = req.query.id;
    if (!id) throw new BadRequestError('Invalid ID');

    const deletedApiKey = await apiKeyService.deleteApiKey(
      userId,
      { id },
      {
        db: {
          apiKeys: apiKeyRepository,
        },
      }
    );

    await logEvent({ userId, type: ApiKeyEvents.DELETE_API_KEY, metadata: { id } }, { ability: req.ability });

    return res.status(200).json(deletedApiKey);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
