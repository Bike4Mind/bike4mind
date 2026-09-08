import type { AccessContext } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { getRequestEntitlements, type EntitlementRequest } from '@server/entitlements';
import { getRequestMembershipOrgIds } from './requestMembership';

/**
 * Builds the `AccessContext` for the data-lake management gates
 * (`assertLakeAccess` / `listDataLakes` / `findAccessible`) from the authenticated
 * principal, resolving the caller's entitlement keys so the gates grant on EITHER the
 * lake's `requiredUserTag` OR its `requiredEntitlement` - the any-of rule shared with the
 * retrieval path.
 *
 * This is the ONE place the management `AccessContext` is constructed: every
 * `/api/data-lakes/**` route (and the data-lake upload door) imports it instead of
 * re-deriving the shape, so threading entitlement keys can't be forgotten at one site.
 * `resolveAccessibleLakes` also reuses its `entitlementKeys` for the pure static-registry
 * filter, which is not a management gate - so the keys must stay correct for both.
 *
 * Async because resolving entitlements reads the user's active subscriptions. The read is
 * memoized per request (`req.entitlements`, via `getRequestEntitlements`), so calling this
 * from multiple handlers within one request costs a single subscription query.
 *
 * Admins skip the resolution entirely: the gates (`canAccessLake`/`findAccessible`) grant an
 * admin immediately and never consult `entitlementKeys` or `administeredOrgIds`, so the extra reads
 * would be pure overhead on every admin data-lake request.
 *
 * `administeredOrgIds` is the caller's org-admin set (billing owner / manager / appointed admin),
 * the input to the org-manageable rung in `canManageLake`: an org admin may manage any lake scoped
 * to one of these orgs. Resolved once here (non-admins only) so every management gate agrees.
 */
export async function toAccessContext(req: EntitlementRequest): Promise<AccessContext> {
  const user = req.user!;
  const isAdmin = !!user.isAdmin;
  return {
    userId: user.id,
    isAdmin,
    userTags: user.tags ?? [],
    // Authoritative membership set (owner + users[] ACL), memoized per request by
    // getRequestMembershipOrgIds - NOT user.organizationId, the selected-org display
    // preference (#1674). Resolved for admins too: the fallback-lake org prerequisite and
    // findBySlug's own-org preference apply to admins as well, unlike the entitlement gates
    // below.
    organizationIds: await getRequestMembershipOrgIds(req),
    entitlementKeys: isAdmin ? [] : await getRequestEntitlements(req),
    administeredOrgIds: isAdmin ? [] : await organizationRepository.findIdsWithAdminRights(user.id),
  };
}
