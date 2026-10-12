import { hasDeveloperUserTag } from './schemas/user';

/**
 * Client-safe product-surface name literals.
 *
 * The `session.surface` field (SessionTypes) scopes a session to a product
 * surface. These are the canonical values for OPEN surfaces whose names are not
 * guarded IP - currently just Opti (`/opti`, the datalake survivor). Both
 * client and server import from here, so the surface contract has one home with
 * zero bundle penalty (`@bike4mind/common` is already client-safe).
 *
 * NOTE: guarded product-surface tokens (the oncology module's surface, etc.)
 * deliberately do NOT live here. Their identity home stays inside the module's
 * owned namespace per the extraction boundary - shared core must never own a
 * guarded token, nor import from an owned namespace. The literal must not even
 * appear in this file (the boundary guard greps for it), which is why this note
 * names no token. See scripts/check-libonc-boundary.sh and the module's
 * EXTRACTION.md §4.
 */

/** Product-surface tag stamped on Opti / OptiHashi (`/opti`) sessions. */
export const OPTI_SURFACE = 'opti';

/** A session's home: `null` is the main notebook list, a string is a product surface. */
export type SurfaceId = string | null;

export type WorkspaceSurfaceIconKey = 'notebook' | 'opti';

/**
 * A workspace a session can be copied or moved into. Only OPEN surfaces are registered; a
 * private surface whose name stays out of this repo is, by construction, never a move/copy
 * target and never movable out (see `checkSurfaceTransition`).
 */
export interface WorkspaceSurface {
  id: SurfaceId;
  label: string;
  iconKey: WorkspaceSurfaceIconKey;
  /** Entitlement key required to use the workspace (admins and developers bypass); null = everyone. */
  requiredEntitlement: string | null;
  /** Whether sessions may be moved or copied into and out of this workspace. */
  movable: boolean;
  /** Route prefix of the workspace, so a client can hide one its build does not ship. */
  routePrefix: string;
  /** Client URL that opens `sessionId` in this workspace. */
  sessionHref: (sessionId: string) => string;
}

export const WORKSPACE_SURFACES: readonly WorkspaceSurface[] = [
  {
    id: null,
    label: 'Notebooks',
    iconKey: 'notebook',
    requiredEntitlement: null,
    movable: true,
    routePrefix: '/notebooks',
    sessionHref: sessionId => `/notebooks/${encodeURIComponent(sessionId)}`,
  },
  {
    id: OPTI_SURFACE,
    label: 'OptiHashi',
    iconKey: 'opti',
    // Must stay in sync with the server gate the surface's own routes enforce (admin || developer ||
    // `optihashi:pro`) and with the client predicate in apps/client/app/hooks/data/opti.ts.
    requiredEntitlement: 'optihashi:pro',
    movable: true,
    routePrefix: '/opti',
    sessionHref: sessionId => `/opti?mode=canvas&session=${encodeURIComponent(sessionId)}`,
  },
];

/** Maps the stored representations of "no surface" (`undefined`, `null`, `''`) to `null`. */
export function normalizeSurfaceId(surface: string | null | undefined): SurfaceId {
  return surface ? surface : null;
}

/** The registered workspace for `surface`, or undefined for a surface this repo does not know. */
export function getWorkspaceSurface(surface: string | null | undefined): WorkspaceSurface | undefined {
  const id = normalizeSurfaceId(surface);
  return WORKSPACE_SURFACES.find(entry => entry.id === id);
}

/** What `canUseSurface` reads off a user: no DB access, so the caller resolves entitlements first. */
export interface SurfaceAccessUser {
  isAdmin?: boolean | null;
  tags?: readonly string[] | null;
  /** The user's resolved entitlement keys (subscriptions, tag grants, domain grants). */
  entitlements?: readonly string[] | null;
  /**
   * Extra entitlement keys per workspace id whose holders may keep a fork, snip or clone of a session
   * in that workspace (see `canCopyWithinSurface`). Host-supplied from what the build's premium
   * overlays declare (apps/client `PremiumWorkspaceCopyEntitlements`); this repo registers none.
   */
  copyEntitlements?: Readonly<Record<string, readonly string[]>> | null;
}

/** True when `surface` is registered and the user may use it. */
export function canUseSurface(user: SurfaceAccessUser | null | undefined, surface: string | null | undefined): boolean {
  const entry = getWorkspaceSurface(surface);
  if (!entry || !user) return false;
  if (!entry.requiredEntitlement) return true;
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;
  const required = entry.requiredEntitlement.trim().toLowerCase();
  return (user.entitlements ?? []).some(key => key.trim().toLowerCase() === required);
}

/**
 * True when `user` may fork, snip or clone a session that lives in `surface` and keep the copy there:
 * anyone `canUseSurface` admits, plus holders of a key `user.copyEntitlements` lists for that
 * workspace. A copy grant is deliberately weaker than use: creating a session in the workspace,
 * moving one into it, or naming it as an explicit copy target all still go through `canUseSurface`.
 */
export function canCopyWithinSurface(
  user: SurfaceAccessUser | null | undefined,
  surface: string | null | undefined
): boolean {
  if (canUseSurface(user, surface)) return true;
  const entry = getWorkspaceSurface(surface);
  // A null id is the main list, which is ungated, so canUseSurface has already answered for it.
  if (!entry?.id || !user?.copyEntitlements) return false;
  const granted = user.copyEntitlements[entry.id];
  if (!Array.isArray(granted) || granted.length === 0) return false;
  const held = new Set((user.entitlements ?? []).map(key => key.trim().toLowerCase()));
  return granted.some(key => held.has(key.trim().toLowerCase()));
}

export type SurfaceTransitionDenial = {
  ok: false;
  /** 400 for a request no caller could make succeed, 403 for one this caller is not entitled to. */
  status: 400 | 403;
  message: string;
};

/**
 * Whether a session living in `from` may be copied or moved into `to` by `user`. Both ends must be
 * registered and movable, and the user must be able to use the destination.
 */
export function checkSurfaceTransition(
  user: SurfaceAccessUser | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined
): { ok: true; target: SurfaceId } | SurfaceTransitionDenial {
  const source = getWorkspaceSurface(from);
  if (!source || !source.movable) {
    return { ok: false, status: 400, message: 'This notebook cannot leave its workspace' };
  }
  const target = getWorkspaceSurface(to);
  if (!target || !target.movable) {
    return { ok: false, status: 400, message: 'Unknown workspace' };
  }
  if (!canUseSurface(user, target.id)) {
    return { ok: false, status: 403, message: 'You do not have access to that workspace' };
  }
  return { ok: true, target: target.id };
}
