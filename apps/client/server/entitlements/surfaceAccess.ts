import type { SurfaceAccessUser } from '@bike4mind/common';
import type { EntitlementRequest } from '@server/entitlements';
import { premiumWorkspaceCopyEntitlements } from '@client/app/premium-generated/premiumWorkspaceCopyEntitlements.generated';

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

/**
 * `surfaceAccessForRequest` plus the overlay-declared copy grant table, for the fork, snip and clone
 * routes only - the one place `canCopyWithinSurface` is consulted. The client's clone/fork menus read
 * the same generated module (app/hooks/useWorkspaceTargets.ts), so what they offer is what this enforces.
 */
export const copySurfaceAccessForRequest = (req: EntitlementRequest) => {
  const resolveAccess = surfaceAccessForRequest(req);
  return async (): Promise<SurfaceAccessUser> => ({
    ...(await resolveAccess()),
    copyEntitlements: premiumWorkspaceCopyEntitlements,
  });
};
