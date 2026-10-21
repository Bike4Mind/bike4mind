import { useCallback } from 'react';
import { useLocation } from '@tanstack/react-router';
import {
  getWorkspaceSurface,
  isSurfaceHidden,
  OPTI_SURFACE,
  VIEW_REGISTRY,
  WORKSPACE_SURFACES,
  type NavigationIntent,
} from '@bike4mind/common';
import { useHiddenSurfaceIds } from '@client/app/hooks/useHiddenSurfaces';
import { useOptiNavigation } from '@client/app/hooks/useOptiNavigation';

// Action targets the view registry files under OptiHashi. Any other action (file_browser, or one
// this build does not know) maps to no workspace, so it is never hidden.
const OPTI_ACTION_TARGETS: ReadonlySet<string> = new Set(
  VIEW_REGISTRY.filter(view => view.section === 'opti' && view.navigationType === 'action').map(view => view.target)
);

const isUnderPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** The registered workspace a suggested navigation leads into, or null for the main app. */
export function intentSurface(intent: NavigationIntent): string | null {
  if (intent.navigationType === 'action') return OPTI_ACTION_TARGETS.has(intent.target) ? OPTI_SURFACE : null;
  if (intent.navigationType !== 'route') return null;
  const path = intent.target.split(/[?#]/)[0];
  const surface = WORKSPACE_SURFACES.find(entry => entry.id !== null && isUnderPrefix(path, entry.routePrefix));
  return surface?.id ?? null;
}

export interface IntentContext {
  hiddenSurfaces: readonly string[];
  pathname: string;
  /** A host is drawing the opti family console in place (useOptiNavigation). */
  hostHandlesFamilyInPlace: boolean;
}

/**
 * True when `intent` leads into a workspace the user hid and they are not already in it (anywhere
 * under its route prefix, or a host drawing it in place).
 */
export function leadsIntoHiddenSurface(intent: NavigationIntent, context: IntentContext): boolean {
  const target = intentSurface(intent);
  if (!target || !isSurfaceHidden(context.hiddenSurfaces, target)) return false;
  const prefix = getWorkspaceSurface(target)?.routePrefix;
  const alreadyThere =
    (!!prefix && isUnderPrefix(context.pathname, prefix)) ||
    (intent.navigationType === 'action' && context.hostHandlesFamilyInPlace);
  return !alreadyThere;
}

/** Predicate for a suggested navigation that leads into a workspace the user hid (see leadsIntoHiddenSurface). */
export function useIsIntentHidden(): (intent: NavigationIntent) => boolean {
  const hiddenSurfaces = useHiddenSurfaceIds();
  const pathname = useLocation({ select: location => location.pathname });
  const hostHandlesFamilyInPlace = useOptiNavigation(state => state.hostHandlesFamilyInPlace);
  return useCallback(
    (intent: NavigationIntent) =>
      leadsIntoHiddenSurface(intent, { hiddenSurfaces, pathname, hostHandlesFamilyInPlace }),
    [hiddenSurfaces, pathname, hostHandlesFamilyInPlace]
  );
}
