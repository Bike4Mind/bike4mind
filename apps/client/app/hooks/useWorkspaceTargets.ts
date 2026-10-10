import { useCallback, useMemo } from 'react';
import {
  canCopyWithinSurface,
  canUseSurface,
  getWorkspaceSurface,
  WORKSPACE_SURFACES,
  type ISessionDocument,
  type SurfaceAccessUser,
  type WorkspaceSurface,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import type { PremiumWorkspaceGrantDisplays } from '@client/app/premiumContract';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { premiumWorkspaceCopyEntitlements } from '@client/app/premium-generated/premiumWorkspaceCopyEntitlements.generated';
import { premiumWorkspaceGrantDisplays } from '@client/app/premium-generated/premiumWorkspaceGrantDisplays.generated';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { NEUTRAL_WORKSPACE_LABEL } from '@client/app/utils/workspaceLabels';

// A product surface ships only in builds that carry its route; offering one without it dead-ends.
export const surfaceRouteExists = (surface: WorkspaceSurface): boolean =>
  surface.id === null || premiumRoutes.some(route => route.path.startsWith(surface.routePrefix));

const SESSION_ID_SLOT = '{sessionId}';

/**
 * `surface` as `user` should see it. A user who can use the workspace gets the registry entry
 * untouched. One who cannot gets the label (and, when declared, the link and route) of the first
 * displayed grant they hold, or else `NEUTRAL_WORKSPACE_LABEL` with the registry link, so menus and
 * dialogs never name a product that user does not have.
 */
export function presentWorkspace(
  surface: WorkspaceSurface,
  user: SurfaceAccessUser,
  displays: PremiumWorkspaceGrantDisplays = premiumWorkspaceGrantDisplays
): WorkspaceSurface {
  if (surface.id === null || canUseSurface(user, surface.id)) return surface;
  const held = new Set((user.entitlements ?? []).map(key => key.trim().toLowerCase()));
  const display = displays[surface.id]?.find(entry => held.has(entry.key.trim().toLowerCase()));
  if (!display) return { ...surface, label: NEUTRAL_WORKSPACE_LABEL };
  const template = display.sessionHref;
  if (!template) return { ...surface, label: display.label };
  return {
    ...surface,
    label: display.label,
    // The path the template opens, so surfaceRouteExists checks the route this user is sent to.
    routePrefix: template.split(/[?{]/)[0].replace(/(.)\/+$/, '$1'),
    sessionHref: sessionId => template.replace(SESSION_ID_SLOT, encodeURIComponent(sessionId)),
  };
}

function useSurfaceAccessUser(): SurfaceAccessUser {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { data: entitlements } = useEntitlements();
  return useMemo(
    () => ({ isAdmin, tags: currentUser?.tags, entitlements, copyEntitlements: premiumWorkspaceCopyEntitlements }),
    [isAdmin, currentUser, entitlements]
  );
}

/** `presentWorkspace` bound to the current user, for a workspace reached outside `useWorkspaceTargets`. */
export function useWorkspacePresenter(): (surface: WorkspaceSurface) => WorkspaceSurface {
  const accessUser = useSurfaceAccessUser();
  return useCallback((surface: WorkspaceSurface) => presentWorkspace(surface, accessUser), [accessUser]);
}

export interface WorkspaceTargets {
  /** The session's registered workspace as the user sees it; undefined for a surface this repo does not register. */
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
  const accessUser = useSurfaceAccessUser();

  return useMemo<WorkspaceTargets>(() => {
    const registered = session ? getWorkspaceSurface(session.surface) : undefined;
    // Only the current workspace can be one the user reaches through a grant alone; every other
    // target passes canUseSurface below, and presentWorkspace leaves those as registered.
    const current = registered && presentWorkspace(registered, accessUser);
    if (!session || !current?.movable) return { current, copyTargets: [], moveTargets: [] };

    const others = WORKSPACE_SURFACES.filter(
      surface =>
        surface.id !== current.id &&
        surface.movable &&
        surfaceRouteExists(surface) &&
        canUseSurface(accessUser, surface.id)
    );
    const isOwner = !!currentUser && session.userId === currentUser.id;
    // A copy into "current" is sent as a plain clone/fork (no explicit targetSurface), which the
    // server only inherits when the caller can copy within that workspace (use it, or hold a copy
    // grant for it) - offering it otherwise would check the box but silently land the copy in the
    // main list instead. Omit it in that case.
    const copyTargets = canCopyWithinSurface(accessUser, current.id) ? [current, ...others] : others;
    return { current, copyTargets, moveTargets: isOwner ? others : [] };
  }, [session, currentUser, accessUser]);
}
