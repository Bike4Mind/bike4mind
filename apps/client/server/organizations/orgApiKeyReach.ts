import type { OrgApiKeyGrant, OrgApiKeyReach } from '@bike4mind/common';
import { groupRepository } from '@bike4mind/database';

/**
 * Resolves an org-owned key's grants (IUserApiKey.orgOwned.grants) into what it may read on this
 * request. Called by apiKeyAuth on every request, never cached, so the reach follows the live org:
 * a deleted group drops out at once, and so does anything unshared from the groups that remain,
 * because the read arms match the resource's own `groups[]` entries.
 *
 * Only the org's own live groups are ever returned: a grant naming another org's group, or a
 * group since moved or deleted, contributes nothing. No grant = default deny (empty reach).
 */
export async function resolveOrgApiKeyReach(
  organizationId: string,
  grants: readonly OrgApiKeyGrant[]
): Promise<OrgApiKeyReach> {
  const empty: OrgApiKeyReach = { organizationId, readGroupIds: [], dataLakeOrgIds: [] };
  if (grants.length === 0) return empty;

  const wholeOrg = grants.some(grant => grant.resourceType === 'organization' && grant.resourceId === organizationId);
  const grantedGroupIds = new Set(grants.flatMap(grant => (grant.resourceType === 'group' ? [grant.resourceId] : [])));
  if (!wholeOrg && grantedGroupIds.size === 0) return empty;

  const orgGroupIds = (await groupRepository.findByOrganization(organizationId)).map(group => String(group.id));
  return {
    organizationId,
    readGroupIds: wholeOrg ? orgGroupIds : orgGroupIds.filter(id => grantedGroupIds.has(id)),
    dataLakeOrgIds: wholeOrg ? [organizationId] : [],
  };
}
