import { logEventSafe } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository } from '@bike4mind/database';
import { ApiKeyEvents } from '@bike4mind/common';

const handler = baseApi().post(async (req, res) => {
  const userId = req.user!.id;
  const body = apiKeyService.createApiKeySchema.parse(req.body);

  const newApiKey = await apiKeyService.createApiKey(userId, body, {
    db: {
      apiKeys: apiKeyRepository,
    },
  });

  await logEventSafe(
    {
      userId,
      type: ApiKeyEvents.CREATE_API_KEY,
      metadata: {
        id: newApiKey.id,
        description: newApiKey.description ?? '',
        isActive: newApiKey.isActive,
        type: newApiKey.type,
      },
    },
    { ability: req.ability },
    req.logger,
    `API key ${newApiKey.id}`
  );

  return res.status(200).json(newApiKey);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
