import type { AccessContext } from '../types/entities/DataLakeTypes';

/** The authenticated user an `AccessContext` is built for, as every surface already holds it. */
export type AccessContextPrincipal = {
  id: string;
  isAdmin?: boolean | null;
  tags?: string[] | null;
};

/**
 * The three reads behind an `AccessContext`, already bound to the principal. Injected so this
 * module stays pure: routes pass their per-request memoized readers, tools their `db` repos,
 * Slack its `deps`.
 */
export type AccessContextResolvers = {
  /** Authoritative membership (org owner + users[] ACL) - never `user.organizationId` (#1674). */
  membershipOrgIds: () => Promise<string[]>;
  entitlementKeys: () => Promise<string[]>;
  /** Orgs the principal holds admin RIGHTS in - the org rungs of `canManageLake`. */
  administeredOrgIds: () => Promise<string[]>;
};

export type AccessContextOptions = {
  /**
   * Build the principal's MEMBER reach: the platform-admin bypass off, so the entitlement and
   * org-admin sets an admin context skips are resolved for real. For a door that must answer
   * "what can this user reach as a member" even for an admin; flipping `isAdmin` on an admin
   * context afterwards would silently drop every entitlement-granted lake.
   */
  asMember?: boolean;
  /**
   * Keep the admin bypass but still resolve entitlement keys, for a caller that deliberately
   * evaluates an admin through the non-admin arms with the keys deciding entitlement-gated reach.
   */
  resolveEntitlementsForAdmin?: boolean;
};

/**
 * The ONE builder of the data-lake `AccessContext` - routes (`server/dataLakes/toAccessContext`),
 * tools (`buildToolAccessContext`) and Slack (`buildSlackAccessContext`) all delegate here, so the
 * shape and the admin rule cannot drift between surfaces.
 *
 * The admin rule: the gates grant a platform admin outright and never read `entitlementKeys` or
 * `administeredOrgIds`, so an admin skips both reads. Membership is resolved for admins too, since
 * the fallback-lake org prerequisite and `findBySlug`'s own-org preference apply to them as well.
 */
export async function buildDataLakeAccessContext(
  principal: AccessContextPrincipal,
  resolvers: AccessContextResolvers,
  options: AccessContextOptions = {}
): Promise<AccessContext> {
  const isAdmin = !!principal.isAdmin && !options.asMember;
  const skipEntitlementKeys = isAdmin && !options.resolveEntitlementsForAdmin;

  const [organizationIds, entitlementKeys, administeredOrgIds] = await Promise.all([
    resolvers.membershipOrgIds(),
    skipEntitlementKeys ? [] : resolvers.entitlementKeys(),
    isAdmin ? [] : resolvers.administeredOrgIds(),
  ]);

  return {
    userId: principal.id,
    isAdmin,
    userTags: principal.tags ?? [],
    organizationIds,
    entitlementKeys,
    administeredOrgIds,
  };
}
