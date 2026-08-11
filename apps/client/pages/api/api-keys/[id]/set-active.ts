import { ApiKeyEvents, ApiKeyType } from '@bike4mind/common';
import { apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';

const handler = baseApi().post(
  asyncHandler<{}, unknown, { type: ApiKeyType }, { id: string }>(async (req, res) => {
    const userId = req.user?.id;
    const id = req.query.id;

    const updatedApiKey = await apiKeyService.setApiKey(
      userId,
      {
        id,
        type: req.body.type,
      },
      {
        db: {
          apiKeys: apiKeyRepository,
        },
      }
    );

    await logEvent({ userId, type: ApiKeyEvents.SET_API_KEY, metadata: { id } }, { ability: req.ability });

    // setApiKey returns the stored document, whose apiKey is ciphertext at rest. Never echo the
    // key field back (matching the create/update write responses); the client only needs the
    // record's metadata and just invalidates its query on success.
    const record = (updatedApiKey as unknown as { toObject?: () => Record<string, unknown> }).toObject?.() ?? {
      ...(updatedApiKey as unknown as Record<string, unknown>),
    };
    delete record.apiKey;
    return res.json(record);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
