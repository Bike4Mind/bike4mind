import { ApiKeyType, IApiKeyRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/common';
import { z } from 'zod';

const createApiKeySchema = z.object({
  apiKey: z.string().min(6),
  description: z.string().optional().prefault(''),
  isActive: z.boolean().optional().prefault(true),
  type: z.enum(ApiKeyType),
  expireDays: z.number().min(1).max(365).prefault(90), // Default 90-day expiration
});

type CreateApiKeyParameters = z.infer<typeof createApiKeySchema>;

interface CreateApikeyAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'create' | 'updateAllByUserId'>;
  };
}

export const createApiKey = async (
  userId: string,
  parameters: CreateApiKeyParameters,
  { db }: CreateApikeyAdapters
) => {
  const { expireDays, ...params } = secureParameters(parameters, createApiKeySchema);

  if (params.isActive) {
    await db.apiKeys.updateAllByUserId(userId, { isActive: false });
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + expireDays);

  const buildApiKey = {
    ...params,

    userId,
    expiresAt,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const result = await db.apiKeys.create(buildApiKey);

  return result;
};
