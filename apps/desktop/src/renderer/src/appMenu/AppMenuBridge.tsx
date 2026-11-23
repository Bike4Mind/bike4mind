import { useEffect } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import type { AppMenuAction } from '@shared/appShell';
import { requestNewChat } from './newChatRequests';

/**
 * Windows that share this renderer but are not the main window: main never sends them menu
 * actions, and they must not take one that was left pending for the main window.
 */
const COMPANION_ROUTES = new Set(['/dev-logs', '/mini-tavern']);

/** Carries out the app menu's actions (main/appMenu.ts). Mounted once, at the router root. */
export function AppMenuBridge() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const isCompanion = COMPANION_ROUTES.has(pathname);

  useEffect(() => {
    // The mini window's preload exposes no window.b4m at all.
    if (isCompanion || typeof window.b4m === 'undefined') return;
    const run = (action: AppMenuAction) => {
      if (action === 'open-settings') {
        void navigate({ to: '/settings' });
        return;
      }
      // Requested before navigating, so a chat view mounted by the navigation picks it up too.
      requestNewChat();
      void navigate({ to: '/' });
    };
    const unsubscribe = window.b4m.appMenu.onAction(run);
    void window.b4m.appMenu.takePending().then(action => {
      if (action) run(action);
    });
    return unsubscribe;
  }, [isCompanion, navigate]);

  return null;
}
