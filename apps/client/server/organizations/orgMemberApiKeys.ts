import { type IOrgMemberApiKeyView, type IUserApiKeyDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from 'mongoose';
import { creatorDisplayName } from './orgApiKeys';

/**
 * Members' own keys billed to an org (org-owned keys are orgApiKeys.ts). Served by
 * pages/api/organizations/[id]/api-keys/members/*, which authorize the caller (manageKeys) first.
 */

export async function listOrgMemberKeys(organizationId: string): Promise<IUserApiKeyDocument[]> {
  const keys = await userApiKeyRepository.findByOrganizationId(organizationId);
  return keys.filter(key => !key.orgOwned);
}

/** Display names for the members holding these keys, one query for the lot. */
export async function resolveHolderNames(keys: Pick<IUserApiKeyDocument, 'userId'>[]): Promise<Map<string, string>> {
  const ids = [...new Set(keys.map(key => key.userId))];
  if (ids.length === 0) return new Map();
  const users = await userRepository.findByIds(ids);
  return new Map(users.map(user => [user.id, creatorDisplayName(user)]));
}

export function toOrgMemberApiKeyView(
  key: IUserApiKeyDocument,
  holderNames: Map<string, string>
): IOrgMemberApiKeyView {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    status: key.status,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    creditsUsed: key.usage?.totalSpendCredits ?? 0,
    createdBy: { id: key.userId, name: holderNames.get(key.userId) ?? null },
  };
}

/** A member key billed to this org; NotFound for an org-owned key, another org's key or a malformed id. */
export async function loadOrgMemberKey(organizationId: string, keyId: string): Promise<IUserApiKeyDocument> {
  const apiKey = isValidObjectId(keyId)
    ? await userApiKeyRepository.findByOrganizationIdsAndId([organizationId], keyId)
    : null;
  if (!apiKey || apiKey.orgOwned) throw new NotFoundError('API key not found');
  return apiKey;
}
