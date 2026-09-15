import { ApiKeyType, IApiKeyRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/common';
import { z } from 'zod';

export const createApiKeySchema = z.object({
  apiKey: z.string().min(6),
  description: z.string().optional().prefault(''),
  isActive: z.boolean().optional().prefault(true),
  type: z.enum(ApiKeyType),
  expireDays: z.number().min(1).max(365).prefault(90), // Default 90-day expiration
});

type CreateApiKeyParameters = z.infer<typeof createApiKeySchema>;

interface CreateApikeyAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'create' | 'updateAllByUserIdAndType'>;
  };
}

export const createApiKey = async (
  userId: string,
  parameters: CreateApiKeyParameters,
  { db }: CreateApikeyAdapters
) => {
  const { expireDays, ...params } = secureParameters(parameters, createApiKeySchema);

  // At most one active key per (userId, type): providers do not compete, so scoping the
  // deactivation by type is what keeps adding one provider's key from stranding the others.
  // set.ts maintains the same invariant and must stay in sync.
  if (params.isActive) {
    await db.apiKeys.updateAllByUserIdAndType(userId, params.type, { isActive: false });
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
