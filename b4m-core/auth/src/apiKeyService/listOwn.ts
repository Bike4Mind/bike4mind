import { IApiKeyRepository } from '@bike4mind/common';
import { obfuscateApiKey } from '@bike4mind/common';

interface ListOwnApiKeysAdapters {
  db: {
    apiKeys: Pick<IApiKeyRepository, 'findAllByUserId'>;
  };
}

interface ListOwnApiKeysOptions {
  obfuscate?: boolean;
}

export const listOwnApiKeys = async (
  userId: string,
  adapters: ListOwnApiKeysAdapters,
  options: ListOwnApiKeysOptions = {}
) => {
  const apiKeys = await adapters.db.apiKeys.findAllByUserId(userId);

  if (options.obfuscate) {
    return apiKeys.map(apiKey => ({
      ...apiKey,
      apiKey: obfuscateApiKey(apiKey.apiKey),
    }));
  }

  return apiKeys;
};
