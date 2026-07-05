import type { AccessContext } from '@bike4mind/common';
import { getRequestEntitlements, type EntitlementRequest } from '@server/entitlements';

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
 *
 * Async because resolving entitlements reads the user's active subscriptions. The read is
 * memoized per request (`req.entitlements`, via `getRequestEntitlements`), so calling this
 * from multiple handlers within one request costs a single subscription query.
 *
 * Admins skip the resolution entirely: the gates (`canAccessLake`/`findAccessible`) grant an
 * admin immediately and never consult `entitlementKeys`, so the subscription read would be
 * pure overhead on every admin data-lake request.
 */
export async function toAccessContext(req: EntitlementRequest): Promise<AccessContext> {
  const user = req.user!;
  const isAdmin = !!user.isAdmin;
  return {
    userId: user.id,
    isAdmin,
    userTags: user.tags ?? [],
    organizationId: user.organizationId ?? undefined,
    entitlementKeys: isAdmin ? [] : await getRequestEntitlements(req),
  };
}
