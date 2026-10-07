import type { SurfaceAccessUser } from '@bike4mind/common';
import type { EntitlementRequest } from '@server/entitlements';

/**
 * Lazy `SurfaceAccessUser` for the request's caller, for `canUseSurface` / the session surface
 * checks in @bike4mind/services. Entitlements come from the same memoized resolver every product
 * gate uses, so a workspace is offered and enforced on the same grants.
 *
 * The resolver is imported at CALL time: its graph reaches the Mongoose models, and only a request
 * naming a registered surface needs it (same reasoning as the lake resolvers in the session routes).
 */
export const surfaceAccessForRequest = (req: EntitlementRequest) => async (): Promise<SurfaceAccessUser> => ({
  isAdmin: req.user?.isAdmin,
  tags: req.user?.tags,
  entitlements: await (await import('@server/entitlements')).getRequestEntitlements(req),
});
