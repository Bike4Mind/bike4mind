import { ApiKeyType, IApiKeyDocument, IApiKeyRepository } from '@bike4mind/common';
import { secureParameters, obfuscateApiKey } from '@bike4mind/common';
import { z } from 'zod';

export const getApiKeySchema = z.object({
  type: z.enum(ApiKeyType),
  nullIfMissing: z.boolean().optional(),
  obfuscate: z.boolean().optional(),
  demoKeyName: z.string().optional(),
});

export type GetApiKeyParamters = z.infer<typeof getApiKeySchema>;

export interface GetApiKeyAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndType'>;
  };
}

export interface GetMultipleApiKeysAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'findByUserIdAndTypes'>;
  };
}

export const getApiKey = async (userId: string, params: GetApiKeyParamters, { db }: GetApiKeyAdapters) => {
  const { type, obfuscate } = secureParameters(params, getApiKeySchema);

  const apiKey = await db.apiKeys.findByUserIdAndType(userId, type);

  if (apiKey && obfuscate) {
    return {
      ...apiKey,
      apiKey: obfuscateApiKey(apiKey.apiKey),
    };
  }

  return apiKey;
};

export const getMultipleApiKeys = async (
  userId: string,
  types: ApiKeyType[],
  { db }: GetMultipleApiKeysAdapters,
  options?: { obfuscate?: boolean }
): Promise<IApiKeyDocument[]> => {
  const apiKeys = await db.apiKeys.findByUserIdAndTypes(userId, types);

  if (options?.obfuscate) {
    return apiKeys.map((apiKey: IApiKeyDocument) => ({
      ...apiKey,
      apiKey: obfuscateApiKey(apiKey.apiKey),
    }));
  }

  return apiKeys;
};
