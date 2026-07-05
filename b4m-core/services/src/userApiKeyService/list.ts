import { IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

interface ListUserApiKeysAdapters {
  db: {
    userApiKeys: IUserApiKeyRepository;
  };
}

export interface ListUserApiKeysOptions {
  includeDisabled?: boolean;
}

export const listUserApiKeys = async (
  userId: string,
  adapters: ListUserApiKeysAdapters,
  options: ListUserApiKeysOptions = {}
): Promise<IUserApiKeyDocument[]> => {
  const { db } = adapters;

  const apiKeys = await db.userApiKeys.findByUserId(userId);

  if (!options.includeDisabled) {
    return apiKeys.filter(key => key.status === 'active');
  }

  return apiKeys;
};
