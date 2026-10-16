import { useCallback } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useAdminModal } from '@client/app/components/admin/useAdminModal';
import { useOptiNavigation } from './useOptiNavigation';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import type { NavigationIntent } from '@bike4mind/common';
import { leadsIntoHiddenSurface } from '@client/app/utils/navigationIntentSurface';
import { useHiddenSurfaceIds } from './useHiddenSurfaces';

// Builds without the OptiHashi overlay (open core) have no /opti route; an
// Opti action intent must no-op there instead of navigating to a dead route.
const optiRouteExists = premiumRoutes.some(route => route.path.startsWith('/opti'));

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
  const isIntentHidden = useIsIntentHidden();

  const execute = useCallback(
    (intent: NavigationIntent) => {
      // A suggestion leading into a workspace the user hid is a no-op, unless they are already in it.
      if (isIntentHidden(intent)) return;
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
    [navigate, setActiveTab, requestFamily, setFileBrowserOpen, hostHandlesFamilyInPlace, isIntentHidden]
  );

  return execute;
}
