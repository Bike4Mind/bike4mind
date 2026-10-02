import { useMemo } from 'react';
import {
  canUseSurface,
  getWorkspaceSurface,
  WORKSPACE_SURFACES,
  type ISessionDocument,
  type WorkspaceSurface,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { useEntitlements } from '@client/app/hooks/data/entitlements';

// A product surface ships only in builds that carry its route; offering one without it dead-ends.
export const surfaceRouteExists = (surface: WorkspaceSurface): boolean =>
  surface.id === null || premiumRoutes.some(route => route.path.startsWith(surface.routePrefix));

export interface WorkspaceTargets {
  /** The session's registered workspace; undefined for a surface this repo does not register. */
  current: WorkspaceSurface | undefined;
  /** Copy (clone/fork) destinations, current first. Empty when the session's surface is not movable. */
  copyTargets: WorkspaceSurface[];
  /** Move destinations, excluding the current one. Empty unless the caller owns a movable session. */
  moveTargets: WorkspaceSurface[];
}

/**
 * Workspaces a session can be cloned, forked or moved into by the current user. Mirrors the
 * server's `checkSurfaceTransition` (@bike4mind/common surfaces.ts), which is what enforces it.
 */
export function useWorkspaceTargets(session: Pick<ISessionDocument, 'surface' | 'userId'> | null | undefined) {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { data: entitlements } = useEntitlements();

  return useMemo<WorkspaceTargets>(() => {
    const current = session ? getWorkspaceSurface(session.surface) : undefined;
    if (!session || !current?.movable) return { current, copyTargets: [], moveTargets: [] };

    const accessUser = { isAdmin, tags: currentUser?.tags, entitlements };
    const others = WORKSPACE_SURFACES.filter(
      surface =>
        surface.id !== current.id &&
        surface.movable &&
        surfaceRouteExists(surface) &&
        canUseSurface(accessUser, surface.id)
    );
    const isOwner = !!currentUser && session.userId === currentUser.id;
    // A copy into "current" is sent as a plain clone/fork (no explicit targetSurface), which the
    // server only inherits when the caller can use that workspace - offering it otherwise would
    // check the box but silently land the copy in the main list instead. Omit it in that case.
    const copyTargets = canUseSurface(accessUser, current.id) ? [current, ...others] : others;
    return { current, copyTargets, moveTargets: isOwner ? others : [] };
  }, [session, currentUser, isAdmin, entitlements]);
}
