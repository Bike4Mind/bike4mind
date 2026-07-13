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

/**
 * List the API keys billed to an organization's credit pool. Used by the org
 * management surface so any org administrator - not just the minter - can see
 * the org's keys. Authorization (is the caller an administrator of this org?)
 * is the caller's responsibility.
 */
export const listOrganizationApiKeys = async (
  organizationId: string,
  adapters: ListUserApiKeysAdapters,
  options: ListUserApiKeysOptions = {}
): Promise<IUserApiKeyDocument[]> => {
  const apiKeys = await adapters.db.userApiKeys.findByOrganizationId(organizationId);

  if (!options.includeDisabled) {
    return apiKeys.filter(key => key.status === 'active');
  }

  return apiKeys;
};
