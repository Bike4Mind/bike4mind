import { type IOrgApiKeyView, type IUserApiKeyDocument, type IUserDocument } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

/**
 * Org-owned API keys: held by the org's service account (b4m-core/common constants/orgServiceAccount.ts)
 * instead of a member, so they keep working when any member leaves. Served by
 * pages/api/organizations/[id]/api-keys/*, which authorize the caller (verifyOrgAccess) first.
 */

export const getOrCreateServiceAccount = (organization: {
  id: string;
  name?: string;
  serviceAccountUserId?: string | null;
}): Promise<IUserDocument> =>
  userApiKeyService.getOrCreateOrgServiceAccount(organization, {
    db: { users: userRepository, organizations: organizationRepository },
  });

export const findServiceAccount = (organizationId: string): Promise<IUserDocument | null> =>
  userApiKeyService.findOrgServiceAccount(organizationId, { db: { users: userRepository } });

/** The org's service account plus one of its keys; NotFound for anything else, including another org's key. */
export async function loadOrgOwnedKey(
  organizationId: string,
  keyId: string
): Promise<{ serviceAccount: IUserDocument; apiKey: IUserApiKeyDocument }> {
  const serviceAccount = await findServiceAccount(organizationId);
  const apiKey = serviceAccount ? await userApiKeyRepository.findByUserIdAndId(serviceAccount.id, keyId) : null;
  if (!serviceAccount || !apiKey || !apiKey.orgOwned || apiKey.organizationId !== organizationId) {
    throw new NotFoundError('API key not found');
  }
  return { serviceAccount, apiKey };
}

/** How a key's creator is shown in the org key list. */
export const creatorDisplayName = (user: Pick<IUserDocument, 'id' | 'name' | 'username' | 'email'>): string =>
  user.name || user.username || user.email || user.id;

/** Display names for the members who created these keys, one query for the lot. */
export async function resolveCreatorNames(keys: Pick<IUserApiKeyDocument, 'orgOwned'>[]): Promise<Map<string, string>> {
  const ids = [...new Set(keys.flatMap(key => (key.orgOwned ? [key.orgOwned.createdByUserId] : [])))];
  if (ids.length === 0) return new Map();
  const users = await userRepository.findByIds(ids);
  return new Map(users.map(user => [user.id, creatorDisplayName(user)]));
}

export function toOrgApiKeyView(key: IUserApiKeyDocument, creatorNames: Map<string, string>): IOrgApiKeyView {
  const creatorId = key.orgOwned?.createdByUserId;
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    status: key.status,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.usage?.lastRequest,
    totalRequests: key.usage?.totalRequests ?? 0,
    createdBy: creatorId ? { id: creatorId, name: creatorNames.get(creatorId) ?? null } : null,
  };
}
