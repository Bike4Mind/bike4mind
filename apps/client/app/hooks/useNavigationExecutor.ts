import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAdminModal } from '@client/app/components/admin/AdminPage';
import { useOptiNavigation } from './useOptiNavigation';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import type { NavigationIntent } from '@bike4mind/common';

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
  const setFileBrowserOpen = useFileBrowser(state => state.setOpen);

  const execute = useCallback(
    (intent: NavigationIntent) => {
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
          const dotIdx = intent.target.indexOf('.');
          if (dotIdx !== -1) {
            requestFamily(intent.target.slice(0, dotIdx), intent.target.slice(dotIdx + 1));
          } else {
            requestFamily(intent.target);
          }
          // @ts-expect-error - /opti is a premium route, not in static route tree
          navigate({ to: '/opti' });
          break;
        }
      }
    },
    [navigate, setActiveTab, requestFamily, setFileBrowserOpen]
  );

  return execute;
}
