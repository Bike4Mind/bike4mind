import { useLayoutEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAdminModal } from '../useAdminModal';
import { adminTabToSlug } from '../adminTabSlugs';
import { adminSearchForTab } from '../adminTabParams';

/** A settings page is left when the path or the admin tab changes; other search params (filters) are not. */
export const leavesAdminSettingsPage = (
  current: { pathname: string; search: object },
  next: { pathname: string; search: object }
) =>
  current.pathname !== next.pathname ||
  ('tab' in current.search ? current.search.tab : undefined) !== ('tab' in next.search ? next.search.tab : undefined);

/**
 * While `dirty`, sends store-first admin tab switches (the sidebar) through the router, so the page's
 * UnsavedChangesGuard can block them. Pair it with that guard on any staged settings page.
 */
export function useRouteAdminTabSwitches(dirty: boolean) {
  const router = useRouter();
  useLayoutEffect(() => {
    if (!dirty) return;
    // Store-first switches would unmount the page before the router could block them.
    // Route the request first; URL-to-store sync can commit it only after the guard permits it.
    const guard = (tab: Parameters<typeof adminTabToSlug>[0]) => {
      const location = router.state.location;
      const slug = adminTabToSlug(tab);
      if (slug === undefined) return false;
      if (location.pathname !== '/admin' || location.search.tab === slug) return true;
      void router.navigate({
        to: '/admin',
        search: previous => adminSearchForTab(previous, slug),
        replace: true,
      });
      return false;
    };
    useAdminModal.getState().setTabChangeGuard(guard);
    return () => {
      if (useAdminModal.getState().tabChangeGuard === guard) useAdminModal.getState().setTabChangeGuard(null);
    };
  }, [dirty, router]);
}
