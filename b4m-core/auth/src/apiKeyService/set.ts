import { ApiKeyType, IApiKeyDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/common';
import { z } from 'zod';

const setApiKeySchema = z.object({
  id: z.string(),
  type: z.enum(ApiKeyType),
});

type SetApiKeyParameters = z.infer<typeof setApiKeySchema>;

interface SetApikeyAdapters {
  db: {
    apiKeys: {
      updateAllByUserIdAndType: (userId: string, type: ApiKeyType, value: Partial<IApiKeyDocument>) => Promise<unknown>;
      findByIdAndUserIdAndType: (id: string, userId: string, type: ApiKeyType) => Promise<IApiKeyDocument | null>;
      update: (value: IApiKeyDocument) => Promise<unknown>;
    };
  };
}

export const setApiKey = async (userId: string, parameters: SetApiKeyParameters, { db }: SetApikeyAdapters) => {
  const { id, type } = secureParameters(parameters, setApiKeySchema);

  const apiKey = await db.apiKeys.findByIdAndUserIdAndType(id, userId, type);
  if (!apiKey) throw new NotFoundError('API key not found');

  // Deactivate all other keys of the same type
  await db.apiKeys.updateAllByUserIdAndType(userId, type, { isActive: false });

  apiKey.isActive = true;

  await db.apiKeys.update(apiKey);

  return apiKey;
};
