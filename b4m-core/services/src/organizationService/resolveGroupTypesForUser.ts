import { IGroupRepository, IUserDocument, getGroupType, isKnownGroupType } from '@bike4mind/common';

interface ResolveGroupTypesAdapters {
  db: {
    groups: Pick<IGroupRepository, 'findByOrganization'>;
  };
  /**
   * Optional audit sink (same shape as setOrganizationGroupTypes'). Both resolvers return a bare
   * `string[]`/`boolean`, so an override-derived resolution is otherwise indistinguishable
   * downstream from real membership - only this function knows the branch was taken (#1236).
   */
  logger?: { info: (message: string) => void };
}

/**
 * Platform-admin resolution override (org-groups #1236): "resolve AS these group types in this org".
 * Lets an admin exercise a persona for testing/demo WITHOUT being written into the org's `users[]`.
 * The caller (overlay #139) owns making it opt-in and non-sticky; the resolver applies it gated on
 * `isAdmin` and scoped to `organizationId`, and logs when it fires if given a logger.
 *
 * Bounded by the CATALOG, not by the org's `allowedGroupTypes` - a deliberate decision, not an
 * oversight. The membership path is implicitly bounded by grants (Group rows exist only where
 * `setOrganizationGroupTypes` provisioned them), so the override can resolve a persona the org was
 * never granted: previewing a type before its grant lands is a real pre-sales/demo use case, and the
 * affordance is admin-only and read-only. Intersecting with `allowedGroupTypes` would remove that.
 * This widened reach is why the branch is logged.
 */
export interface GroupTypeResolutionOverride {
  /** The org the admin is operating in - the override applies ONLY when resolving this org. */
  organizationId: string;
  /** Group-type keys to resolve as (validated against GROUP_TYPE_CATALOG; unknown keys dropped). */
  groupTypes: string[];
}

/**
 * Does the override apply for this user resolving this org? isAdmin-only and scoped to the override's
 * org, so it can never widen a non-admin or bleed across tenants.
 *
 * Shared so the two resolvers cannot drift: this one APPLIES the override, while
 * `resolveCapabilitiesForUser` must know it fired in order to skip the billing-owner union that would
 * otherwise pollute the persona being previewed.
 */
export function isGroupTypeOverrideActive(
  override: GroupTypeResolutionOverride | undefined,
  user: { isAdmin?: boolean },
  organizationId: string
): override is GroupTypeResolutionOverride {
  return override !== undefined && user.isAdmin === true && override.organizationId === organizationId;
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
 *
 * OVERRIDE TRUST BOUNDARY (#1236): the CALLER is the trust boundary for both `user.isAdmin` and
 * `override`. The `user` param is a structural type and is never re-read from the database, so a
 * caller that hand-builds `{ groups, isAdmin: true }` - or forwards an unvalidated request body -
 * defeats the gate. Callers must take `isAdmin` from the persisted user document and validate that
 * `override.groupTypes` is an array of strings (a non-array throws inside this authorization path).
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
  // Platform-admin override (#1236): resolve AS the given types, no membership read. This changes
  // only what is RESOLVED, never what is written - the write-path invariant (#1227/#1231) is
  // untouched. Unknown keys are dropped just like the membership path, but named in the log line:
  // a typo'd persona key otherwise resolves silently to [] and looks like a deliberate empty set.
  if (isGroupTypeOverrideActive(override, user, organizationId)) {
    const resolved = [...new Set(override.groupTypes.filter(isKnownGroupType))].sort(byCatalogPriority);
    const dropped = [...new Set(override.groupTypes.filter(key => !isKnownGroupType(key)))];
    adapters.logger?.info(
      `Group-type resolution override applied in organization ${organizationId}: ` +
        `resolved as [${resolved.join(', ')}]` +
        (dropped.length > 0 ? `; dropped unknown key(s): [${dropped.join(', ')}]` : '')
    );
    return resolved;
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
