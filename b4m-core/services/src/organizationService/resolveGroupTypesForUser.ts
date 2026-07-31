import { IGroupRepository, IUserDocument, getGroupType, isKnownGroupType } from '@bike4mind/common';

interface ResolveGroupTypesAdapters {
  db: {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
}

/**
 * Platform-admin resolution override (org-groups #1236): "resolve AS these group types in this org".
 * Lets an admin exercise a persona for testing/demo WITHOUT being written into the org's `users[]`.
 * The caller (overlay #139) owns making it opt-in, non-sticky, and logged; the resolver just applies
 * it, gated on `isAdmin` and scoped to `organizationId`.
 */
export interface GroupTypeResolutionOverride {
  /** The org the admin is operating in - the override applies ONLY when resolving this org. */
  organizationId: string;
  /** Group-type keys to resolve as (validated against GROUP_TYPE_CATALOG; unknown keys dropped). */
  groupTypes: string[];
}

/** Catalog-priority order (lower first), stable by key - shared by the membership and override paths. */
const byCatalogPriority = (a: string, b: string): number => {
  const pa = getGroupType(a)?.priority ?? Number.MAX_SAFE_INTEGER;
  const pb = getGroupType(b)?.priority ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.localeCompare(b);
};

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
  {
    user,
    organizationId,
    override,
  }: {
    user: Pick<IUserDocument, 'groups'> & { isAdmin?: boolean };
    organizationId: string;
    override?: GroupTypeResolutionOverride;
  },
  adapters: ResolveGroupTypesAdapters
): Promise<string[]> {
  // Platform-admin override (#1236): resolve AS the given types, no membership read. isAdmin-only and
  // scoped to the override's org, so it can never widen a non-admin or bleed into another org. This
  // changes only what is RESOLVED, never what is written - the write-path invariant (#1227/#1231) is
  // untouched. Unknown keys are dropped just like the membership path.
  if (override && user.isAdmin === true && override.organizationId === organizationId) {
    return [...new Set(override.groupTypes.filter(isKnownGroupType))].sort(byCatalogPriority);
  }

  const memberGroupIds = new Set(user.groups ?? []);
  if (memberGroupIds.size === 0) return [];

  const orgGroups = await adapters.db.groups.findByOrganization(organizationId);

  const types = new Set<string>();
  for (const group of orgGroups) {
    if (memberGroupIds.has(group.id) && isKnownGroupType(group.type)) {
      types.add(group.type);
    }
  }

  return [...types].sort(byCatalogPriority);
}
