import { useCallback } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useAdminModal } from '@client/app/components/admin/useAdminModal';
import { useOptiNavigation } from './useOptiNavigation';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { isSurfaceHidden, OPTI_SURFACE, WORKSPACE_SURFACES, type NavigationIntent } from '@bike4mind/common';
import { hostedWorkspaceAt } from '@client/app/utils/premiumHostedWorkspace';
import { useHiddenSurfaceIds } from './useHiddenSurfaces';

// Builds without the OptiHashi overlay (open core) have no /opti route; an
// Opti action intent must no-op there instead of navigating to a dead route.
const optiRouteExists = premiumRoutes.some(route => route.path.startsWith('/opti'));

/** The registered workspace a suggested navigation leads into, or null for the main app. */
function intentSurface(intent: NavigationIntent): string | null {
  if (intent.navigationType === 'action') return intent.target === 'file_browser' ? null : OPTI_SURFACE;
  if (intent.navigationType !== 'route') return null;
  const path = intent.target.split(/[?#]/)[0];
  const surface = WORKSPACE_SURFACES.find(
    entry => entry.id !== null && (path === entry.routePrefix || path.startsWith(`${entry.routePrefix}/`))
  );
  return surface?.id ?? null;
}

/**
 * Hook that dispatches navigation based on a NavigationIntent's navigationType.
 * - route  -> Tanstack Router navigate
 * - tab    -> Admin modal setActiveTab + navigate to /admin
 * - action -> Opti family selection via Zustand pub/sub
 */
export function useNavigationExecutor() {
  const navigate = useNavigate();
  const setActiveTab = useAdminModal(state => state.setActiveTab);
  const requestFamily = useOptiNavigation(state => state.requestFamily);
  const hostHandlesFamilyInPlace = useOptiNavigation(state => state.hostHandlesFamilyInPlace);
  const setFileBrowserOpen = useFileBrowser(state => state.setOpen);
  const hiddenSurfaces = useHiddenSurfaceIds();
  const pathname = useLocation({ select: location => location.pathname });

  const execute = useCallback(
    (intent: NavigationIntent) => {
      // A suggestion leading into a workspace the user hid is a no-op, unless they are already in it
      // (its own route, or a host drawing it in place).
      const target = intentSurface(intent);
      const alreadyThere =
        hostedWorkspaceAt(pathname, premiumRoutes) === target ||
        (intent.navigationType === 'action' && hostHandlesFamilyInPlace);
      if (target && isSurfaceHidden(hiddenSurfaces, target) && !alreadyThere) return;
      switch (intent.navigationType) {
        case 'route':
          navigate({ to: intent.target });
          break;

        case 'tab': {
          // Admin tab: set the active tab then navigate to /admin
          const tabIndex = parseInt(intent.target, 10);
          if (!isNaN(tabIndex)) {
            setActiveTab(tabIndex);
          }
          navigate({ to: '/admin' });
          break;
        }

        case 'action': {
          // File browser: open the global modal
          if (intent.target === 'file_browser') {
            setFileBrowserOpen(true);
            break;
          }
          // Opti family action: dispatch via Zustand store, then navigate to /opti
          // Support composite targets: "scheduling.solvers" -> family + subTab
          if (!optiRouteExists) break;
          // userInitiated marks this as a click rather than the replayed side effect, so
          // the surface honours it instead of dropping it the way it drops a replay.
          const dotIdx = intent.target.indexOf('.');
          if (dotIdx !== -1) {
            requestFamily(intent.target.slice(0, dotIdx), intent.target.slice(dotIdx + 1), { userInitiated: true });
          } else {
            requestFamily(intent.target, undefined, { userInitiated: true });
          }
          // A host showing the console in its own pane is already on screen and owns
          // its own way back, so the request above is the whole navigation.
          if (hostHandlesFamilyInPlace) break;
          // Name the target view in the search params rather than leaving the route to
          // its default, which would render the wrong view for a frame before the
          // consumer switches. The updater form is required: router-core passes a plain
          // search object straight through, replacing every other param on the way in.
          // @ts-expect-error - /opti is a premium route, not in static route tree
          navigate({ to: '/opti', search: prev => ({ ...prev, mode: 'optimize' }) });
          break;
        }
      }
    },
    [navigate, setActiveTab, requestFamily, setFileBrowserOpen, hostHandlesFamilyInPlace, hiddenSurfaces, pathname]
  );

  return execute;
}
