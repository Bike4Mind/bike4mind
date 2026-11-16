import {
  ApiKeyStatus,
  type IOrgApiKeyView,
  type IUserApiKeyDocument,
  type IUserDocument,
  type OrgApiKeyGrant,
} from '@bike4mind/common';
import { groupRepository, organizationRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userApiKeyService } from '@bike4mind/services';
import { isOrgApiKeyScopeOffered, orgApiKeyScopesFor } from '@bike4mind/server-utils/app/constants/apiKeyScopes';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { resolveApiKeyScopeAccessForOrganization } from '@server/entitlements/apiKeyScopeAccess';

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
    grants: key.orgOwned?.grants ?? [],
    status: key.status,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    // Key validation stamps the top-level field; `usage.lastRequest` has no writer.
    lastUsedAt: key.lastUsedAt,
    creditsUsed: key.usage?.totalSpendCredits ?? 0,
    createdBy: creatorId ? { id: creatorId, name: creatorNames.get(creatorId) ?? null } : null,
  };
}

/** What an admin may pick for an org key: the scopes the org is entitled to and the org's live groups. */
export async function orgApiKeyOptions(
  organizationId: string
): Promise<{ scopes: string[]; groups: { id: string; name: string }[] }> {
  const [access, groups] = await Promise.all([
    resolveApiKeyScopeAccessForOrganization(organizationId),
    groupRepository.findByOrganization(organizationId),
  ]);
  return {
    scopes: orgApiKeyScopesFor(access).map(scope => scope.value),
    groups: groups.map(group => ({ id: String(group.id), name: group.name })),
  };
}

/** Refuses any scope whose product gate the org does not pass (judged on the org, never the admin). */
export async function assertOrgApiKeyScopesOffered(organizationId: string, scopes: readonly string[]): Promise<void> {
  const access = await resolveApiKeyScopeAccessForOrganization(organizationId);
  const refused = scopes.filter(scope => !isOrgApiKeyScopeOffered(scope, access));
  if (refused.length > 0) {
    throw new ForbiddenError(`Scope not available to this organization: ${refused.join(', ')}`);
  }
}

/** Rotate and edit apply only to a key that still authenticates: active and not past its expiry. */
export function assertOrgApiKeyLive(key: Pick<IUserApiKeyDocument, 'status' | 'expiresAt'>, action: string): void {
  const expired = !!key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
  if (key.status !== ApiKeyStatus.ACTIVE || expired) {
    throw new BadRequestError(`Only an active key can be ${action}`);
  }
}

/**
 * Validates and de-duplicates an org key's grants: an `organization` grant must name this org, a
 * `group` grant one of its live groups. Anything else is a 400 rather than a silently dead grant,
 * except a group grant the key already held (`held`) whose group has since been deleted: that one
 * is dropped, so an edit of an older key is never blocked by a group nobody can pick any more.
 */
export async function normalizeOrgApiKeyGrants(
  organizationId: string,
  grants: readonly OrgApiKeyGrant[],
  held: readonly OrgApiKeyGrant[] = []
): Promise<OrgApiKeyGrant[]> {
  if (grants.some(grant => grant.resourceType === 'organization' && grant.resourceId !== organizationId)) {
    throw new BadRequestError('An organization grant must name this organization');
  }
  const groupIds = grants.flatMap(grant => (grant.resourceType === 'group' ? [grant.resourceId] : []));
  let orgGroupIds = new Set<string>();
  if (groupIds.length > 0) {
    orgGroupIds = new Set((await groupRepository.findByOrganization(organizationId)).map(group => String(group.id)));
    const heldGroupIds = new Set(held.flatMap(grant => (grant.resourceType === 'group' ? [grant.resourceId] : [])));
    if (groupIds.some(id => !orgGroupIds.has(id) && !heldGroupIds.has(id))) {
      throw new BadRequestError("A group grant must name one of this organization's groups");
    }
  }
  const seen = new Set<string>();
  return grants.filter(grant => {
    if (grant.resourceType === 'group' && !orgGroupIds.has(grant.resourceId)) return false;
    const key = `${grant.resourceType}:${grant.resourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
