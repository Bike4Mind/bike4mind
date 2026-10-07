import { buildDataLakeAccessContext, type AccessContext, type AccessContextOptions } from '@bike4mind/common';
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
 * This is the ONE request-side entry to the management `AccessContext`: every
 * `/api/data-lakes/**` route (and the data-lake upload door) imports it instead of
 * re-deriving the shape, so threading entitlement keys can't be forgotten at one site. The shape and
 * the admin rule live in the shared `buildDataLakeAccessContext`, which tools and Slack call too.
 * `resolveAccessibleLakes` also reuses its `entitlementKeys` for the pure static-registry
 * filter, which is not a management gate - so the keys must stay correct for both.
 *
 * Async because resolving entitlements reads the user's active subscriptions. The read is
 * memoized per request (`req.entitlements`, via `getRequestEntitlements`), so calling this
 * from multiple handlers within one request costs a single subscription query.
 *
 * `administeredOrgIds` is the caller's org-admin set (billing owner / manager / appointed admin),
 * the input to the org-manageable rung in `canManageLake`: an org admin may manage any lake scoped
 * to one of these orgs. Resolved once here (non-admins only) so every management gate agrees.
 */
export async function toAccessContext(req: EntitlementRequest): Promise<AccessContext> {
  return buildAccessContext(req);
}

/**
 * The caller's MEMBER reach: the same context with the platform-admin bypass off, and the
 * entitlement and org-admin sets an admin context skips resolved for real. For a door that
 * must answer "what can this user reach as a member" even for an admin (the public
 * `GET /api/v1/data-lakes` list), where flipping `isAdmin` on a `toAccessContext` result would
 * silently drop every entitlement-granted lake.
 */
export async function toMemberAccessContext(req: EntitlementRequest): Promise<AccessContext> {
  return buildAccessContext(req, { asMember: true });
}

function buildAccessContext(req: EntitlementRequest, options?: AccessContextOptions): Promise<AccessContext> {
  const user = req.user!;
  return buildDataLakeAccessContext(
    user,
    {
      membershipOrgIds: () => getRequestMembershipOrgIds(req),
      entitlementKeys: () => getRequestEntitlements(req),
      administeredOrgIds: () => organizationRepository.findIdsWithAdminRights(user.id),
    },
    options
  );
}
