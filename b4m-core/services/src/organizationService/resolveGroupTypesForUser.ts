import { IGroupRepository, IUserDocument, getGroupType, isKnownGroupType } from '@bike4mind/common';

interface ResolveGroupTypesAdapters {
  db: {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
}

/**
 * Resolve which GROUP-TYPE keys a user holds WITHIN one organization (org-groups #1235).
 *
 * `user.groups[]` stores bare Group ids with no type or org qualifier, so a consumer that wants
 * "is this user in the org's `sales` group" cannot answer from the user doc alone. This is the
 * single primitive the epic promises core will supply: it loads the org's LIVE groups
 * (`findByOrganization` excludes soft-deleted rows) and maps the user's membership to catalog
 * type keys. Scoping through the org's own groups is what makes the result org-qualified - a user
 * carrying another tenant's group ids in `user.groups` contributes nothing here.
 *
 * Returns the DISTINCT known type keys, sorted by catalog `priority` (lower first) - the order a
 * multi-type landing card menu uses (#137). Unknown keys (a `Group.type` not in GROUP_TYPE_CATALOG,
 * e.g. a retired type) are dropped, so the result is always a valid subset of the catalog.
 *
 * Membership only, and deliberately side-effect-free: it confers nothing by itself. Capability
 * resolution and the billing-owner implicit-hold are layered on top in #1234, NOT here, so this
 * mirrors the hardened write-path invariant's org scoping without duplicating its authorization.
 */
export async function resolveGroupTypesForUser(
  { user, organizationId }: { user: Pick<IUserDocument, 'groups'>; organizationId: string },
  adapters: ResolveGroupTypesAdapters
): Promise<string[]> {
  const memberGroupIds = new Set(user.groups ?? []);
  if (memberGroupIds.size === 0) return [];

  const orgGroups = await adapters.db.groups.findByOrganization(organizationId);

  const types = new Set<string>();
  for (const group of orgGroups) {
    if (memberGroupIds.has(group.id) && isKnownGroupType(group.type)) {
      types.add(group.type);
    }
  }

  return [...types].sort((a, b) => {
    const pa = getGroupType(a)?.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = getGroupType(b)?.priority ?? Number.MAX_SAFE_INTEGER;
    return pa - pb || a.localeCompare(b);
  });
}
