import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { apiKeyService } from '@bike4mind/services';
import { apiKeyRepository } from '@bike4mind/database';
import { ApiKeyEvents, ApiKeyType } from '@bike4mind/common';
import * as z from 'zod';

const createApiKeyBodySchema = z.object({
  apiKey: z.string().min(6),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  type: z.nativeEnum(ApiKeyType),
  expireDays: z.number().min(1).max(365).optional(),
});

const handler = baseApi().post(async (req, res) => {
  const userId = req.user!.id;
  const body = createApiKeyBodySchema.parse(req.body);

  const newApiKey = await apiKeyService.createApiKey(userId, body, {
    db: {
      apiKeys: apiKeyRepository,
    },
  });

  await logEvent(
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
    { ability: req.ability }
  );

  return res.status(200).json(newApiKey);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
