import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { AdminTab } from './adminSidebarConfig';
import { adminTabFromSlug, adminTabToSlug } from './adminTabSlugs';
import { adminSearchForTab } from './adminTabParams';

/** The admin tab store holds non-member strings too, written by other surfaces. */
type AdminTabValue = AdminTab | string | null;

export type IsAdminTabRenderable = (tab: AdminTab) => boolean;

const ALL_TABS_RENDERABLE: IsAdminTabRenderable = () => true;

/**
 * Keeps the admin console's active tab in the URL (`/admin?tab=<slug>`).
 *
 * URL -> store: a `?tab=` slug selects the tab, so a pasted link, a reload, or back/forward
 * lands on the tab it names.
 *
 * Store -> URL: the URL follows the store, because the tab is also driven from outside this page
 * (the sidebar, the chat model picker's "manage models" shortcut) and a bare `/admin` navigation
 * would otherwise strip the param. `replace` keeps tab changes out of the history stack.
 * A caller that navigates with extra params must not also set the store: the mirror can run before the router commits the new URL and would rebuild search without them.
 *
 * `isTabRenderable` rules out tabs the page cannot currently draw (a gate is off, or the value has
 * no panel): such a tab is never selected, and one already selected falls back to Users, so a
 * crafted link cannot leave the console on a blank pane.
 */
export function useAdminTabUrlSync(
  activeTab: AdminTabValue,
  setActiveTab: (tab: AdminTabValue) => void,
  isTabRenderable: IsAdminTabRenderable = ALL_TABS_RENDERABLE
): void {
  const { tab: requestedTabSlug } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isOnAdminRoute = pathname === '/admin';

  const resolveRequestedTab = useCallback(
    (slug: string | undefined): AdminTab | undefined => {
      const tab = adminTabFromSlug(slug);
      return tab !== undefined && isTabRenderable(tab) ? tab : undefined;
    },
    [isTabRenderable]
  );

  // Keyed on the slug, NOT on activeTab, so it only fires when the URL itself changes (first
  // load, a pasted link, back/forward). It also re-runs when a gate resolves, re-checking a slug
  // that arrived while the gate was still unknown.
  useEffect(() => {
    const requestedTab = resolveRequestedTab(requestedTabSlug);
    if (requestedTab !== undefined) {
      setActiveTab(requestedTab);
    }
  }, [requestedTabSlug, setActiveTab, resolveRequestedTab]);

  // A tab the console cannot render would leave a blank pane. The selection can come from the
  // URL, another surface, or a gate that resolved after the tab was chosen, so correct the store
  // rather than only the URL - the mirror below then writes the corrected slug back.
  useEffect(() => {
    if (typeof activeTab !== 'number' || isTabRenderable(activeTab)) return;
    setActiveTab(AdminTab.Users);
  }, [activeTab, setActiveTab, isTabRenderable]);

  const lastMirroredTabRef = useRef(activeTab);
  useEffect(() => {
    if (!isOnAdminRoute) return;
    const tabChanged = lastMirroredTabRef.current !== activeTab;
    lastMirroredTabRef.current = activeTab;
    // Never write a slug while the URL names a tab the console can render: on mount that would
    // overwrite a deep link before the effect above has applied it, including on StrictMode's
    // double-run, which a first-run flag misses.
    if (!tabChanged && resolveRequestedTab(requestedTabSlug) !== undefined) return;
    const slug = adminTabToSlug(activeTab);
    if (slug === undefined || slug === requestedTabSlug) return;
    navigate({
      to: '/admin',
      // Rebuilt from the param registry, so the new tab's own params survive and nothing else does
      search: previous => adminSearchForTab(previous, slug),
      replace: true,
    });
  }, [activeTab, isOnAdminRoute, navigate, requestedTabSlug, resolveRequestedTab]);
}
