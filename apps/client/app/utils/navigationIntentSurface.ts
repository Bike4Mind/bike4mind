import { isSurfaceHidden, OPTI_SURFACE, WORKSPACE_SURFACES, type NavigationIntent } from '@bike4mind/common';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { hostedWorkspaceAt } from './premiumHostedWorkspace';

/** The registered workspace a suggested navigation leads into, or null for the main app. */
export function intentSurface(intent: NavigationIntent): string | null {
  if (intent.navigationType === 'action') return intent.target === 'file_browser' ? null : OPTI_SURFACE;
  if (intent.navigationType !== 'route') return null;
  const path = intent.target.split(/[?#]/)[0];
  const surface = WORKSPACE_SURFACES.find(
    entry => entry.id !== null && (path === entry.routePrefix || path.startsWith(`${entry.routePrefix}/`))
  );
  return surface?.id ?? null;
}

export interface IntentContext {
  hiddenSurfaces: readonly string[];
  pathname: string;
  /** A host is drawing the opti family console in place (useOptiNavigation). */
  hostHandlesFamilyInPlace: boolean;
}

/**
 * True when `intent` leads into a workspace the user hid and they are not already in it (its own
 * route, or a host drawing it in place). Shared by useNavigationExecutor (no-op) and
 * NavigationButtons (no button), so the two cannot disagree.
 */
export function leadsIntoHiddenSurface(intent: NavigationIntent, context: IntentContext): boolean {
  const target = intentSurface(intent);
  if (!target || !isSurfaceHidden(context.hiddenSurfaces, target)) return false;
  const alreadyThere =
    hostedWorkspaceAt(context.pathname, premiumRoutes) === target ||
    (intent.navigationType === 'action' && context.hostHandlesFamilyInPlace);
  return !alreadyThere;
}
