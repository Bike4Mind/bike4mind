import {
  BadRequestError,
  canCopyWithinSurface,
  checkSurfaceTransition,
  ForbiddenError,
  getWorkspaceSurface,
  type SurfaceAccessUser,
  type SurfaceId,
} from '@bike4mind/common';
import { z } from 'zod';

/** Optional `targetSurface` request field shared by the clone, fork and move inputs. */
export const targetSurfaceSchema = z.string().nullable().optional();

/**
 * Resolves the caller's surface-access inputs (admin flag, tags, entitlements). Lazy because the
 * entitlement read costs a query and only a request naming a target surface needs it.
 */
export type ResolveSurfaceAccess = () => Promise<SurfaceAccessUser>;

/**
 * Throws the 400/403 that `checkSurfaceTransition` describes, or returns the destination surface.
 * Fails closed with a 403 when no access resolver was supplied.
 */
export async function assertSurfaceTransition(
  from: string | null | undefined,
  to: string | null,
  resolveSurfaceAccess: ResolveSurfaceAccess | undefined
): Promise<SurfaceId> {
  const user = resolveSurfaceAccess ? await resolveSurfaceAccess() : null;
  const result = checkSurfaceTransition(user, from, to);
  if (result.ok) return result.target;
  throw result.status === 403 ? new ForbiddenError(result.message) : new BadRequestError(result.message);
}

/**
 * The surface a clone, fork or snip of a session in `sourceSurface` is created in, in the form
 * createSession takes. An absent `targetSurface` inherits the source's home, except that a
 * registered workspace the caller cannot copy within (`canCopyWithinSurface`, e.g. a share holder
 * with neither its entitlement nor a copy grant for it) falls back to the main list. A surface this
 * repo does not register is inherited unchanged. A present `targetSurface` is a transition and
 * needs full use of the destination.
 *
 * That the copy never lands somewhere its owner cannot open is guaranteed here only for callers who
 * can use the workspace. A copy grant keeps the copy in the workspace for a caller who cannot, and
 * nothing in this function checks that the granted key opens it. That is an obligation on whoever
 * declares the grant: the workspace's route and API gates must admit the same key (apps/client
 * `PremiumWorkspaceCopyEntitlements`, cross-checked at codegen), or the copy leaves the main list
 * for a workspace its owner is turned away from.
 */
export async function resolveCopySurface(
  sourceSurface: string | null | undefined,
  targetSurface: string | null | undefined,
  resolveSurfaceAccess: ResolveSurfaceAccess | undefined
): Promise<string | undefined> {
  if (targetSurface === undefined) {
    if (!sourceSurface || !getWorkspaceSurface(sourceSurface)) return sourceSurface || undefined;
    const user = resolveSurfaceAccess ? await resolveSurfaceAccess() : null;
    return canCopyWithinSurface(user, sourceSurface) ? sourceSurface : undefined;
  }
  return (await assertSurfaceTransition(sourceSurface, targetSurface, resolveSurfaceAccess)) ?? undefined;
}
