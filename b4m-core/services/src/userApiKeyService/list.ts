import { ApiKeyScope, IUserApiKeyDocument, IUserApiKeyRepository } from '@bike4mind/common';

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

/**
 * List the active embed keys bound to an agent. The finder is agentId-scoped
 * already; the scope filter is defensive so a non-embed key that somehow
 * carries a stray agentId never surfaces on an embed listing. Authorization
 * (may the caller see this agent's keys?) is the caller's responsibility.
 */
export const listAgentEmbedKeys = async (
  agentId: string,
  adapters: ListUserApiKeysAdapters
): Promise<IUserApiKeyDocument[]> => {
  const keys = await adapters.db.userApiKeys.findByAgentId(agentId);
  return keys.filter(key => key.scopes.includes(ApiKeyScope.EMBED_CHAT));
};
