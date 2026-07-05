import { IApiKeyRepository } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/common';
import { z } from 'zod';

const deleteApiKeySchema = z.object({
  id: z.string(),
});

type DeleteApiKeyParameters = z.infer<typeof deleteApiKeySchema>;

interface DeleteApiKeyAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'delete' | 'findByIdAndUserId'>;
  };
}

export const deleteApiKey = async (
  userId: string,
  parameters: DeleteApiKeyParameters,
  { db }: DeleteApiKeyAdapters
) => {
  const { id } = secureParameters(parameters, deleteApiKeySchema);

  const apiKey = await db.apiKeys.findByIdAndUserId(id, userId);

  if (!apiKey) {
    throw new NotFoundError('API key not found');
  }

  await db.apiKeys.delete(id);

  return apiKey;
};
