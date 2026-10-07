import {
  BadRequestError,
  canUseSurface,
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
 * The surface a clone or fork of a session in `sourceSurface` is created in, in the form
 * createSession takes. An absent `targetSurface` inherits the source's home, except that a
 * registered workspace the caller cannot use (e.g. a share holder without its entitlement) falls
 * back to the main list, so the copy never lands somewhere its owner cannot open. A surface this
 * repo does not register is inherited unchanged.
 */
export async function resolveCopySurface(
  sourceSurface: string | null | undefined,
  targetSurface: string | null | undefined,
  resolveSurfaceAccess: ResolveSurfaceAccess | undefined
): Promise<string | undefined> {
  if (targetSurface === undefined) {
    if (!sourceSurface || !getWorkspaceSurface(sourceSurface)) return sourceSurface || undefined;
    const user = resolveSurfaceAccess ? await resolveSurfaceAccess() : null;
    return canUseSurface(user, sourceSurface) ? sourceSurface : undefined;
  }
  return (await assertSurfaceTransition(sourceSurface, targetSurface, resolveSurfaceAccess)) ?? undefined;
}
