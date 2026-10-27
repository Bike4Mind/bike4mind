import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import { ADMIN_ORGANIZATIONS_TAB_SLUG } from './adminTabParams';
import {
  DEFAULT_ORGANIZATIONS_PARAMS,
  ORGS_ORG_ID_PARAM,
  isSameOrganizationsView,
  organizationsViewFromSearch,
  organizationsViewToSearch,
  type OrganizationsTabParams,
} from './organizationsTabSearch';

const ADMIN_PATH = '/admin';

// Persist key must stay 'admin-organizations-tab-01': changing it silently discards every admin's
// saved filters.
export const useOrganizationsTab = create<{
  params: OrganizationsTabParams;
  setParams: (params: Partial<OrganizationsTabParams>) => void;
}>()(
  persist(
    (set, get) => ({
      params: { ...DEFAULT_ORGANIZATIONS_PARAMS },
      setParams: params => set({ params: { ...get().params, ...params } }),
    }),
    { name: 'admin-organizations-tab-01' }
  )
);

type SearchRecord = Record<string, unknown>;

const VIEW_KEYS = ['page', 'limit', 'sortBy', 'sortDirection', 'personal'] as const;

const touchesView = (patch: Partial<OrganizationsTabParams>) => VIEW_KEYS.some(key => key in patch);

const writeStoredViewToUrl = (previous: SearchRecord): SearchRecord => ({
  ...previous,
  ...organizationsViewToSearch(useOrganizationsTab.getState().params),
});

/**
 * The URL owns the list view when it carries one; the persisted store holds the free-text search and
 * a copy of the view for a bare `?tab=organizations`. Every write goes to both.
 */
export const useOrganizationsParams = (): readonly [
  OrganizationsTabParams,
  (patch: Partial<OrganizationsTabParams>) => void,
] => {
  const [storedParams, setStoredParams] = useOrganizationsTab(useShallow(state => [state.params, state.setParams]));
  const router = useRouter();
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => organizationsViewFromSearch(search), [search]);

  const params = useMemo(() => (urlView ? { ...storedParams, ...urlView } : storedParams), [storedParams, urlView]);

  const setParams = useCallback(
    (patch: Partial<OrganizationsTabParams>) => {
      setStoredParams(patch);
      if (!touchesView(patch)) return;
      // SearchBar's debounced callback can fire after the tab unmounts, and it must never navigate back to /admin or write onto another tab.
      const { pathname, search } = router.state.location;
      if (pathname !== ADMIN_PATH || (search as SearchRecord)[ADMIN_TAB_PARAM] !== ADMIN_ORGANIZATIONS_TAB_SLUG) return;
      // Written from the store, which useOrganizationsTabUrlSync keeps level with the URL and which
      // already holds this patch merged into the full view, so the URL always carries a complete view.
      navigate({ to: ADMIN_PATH, search: writeStoredViewToUrl, replace: true });
    },
    [navigate, router, setStoredParams]
  );

  return [params, setParams] as const;
};

/**
 * A URL view wins and is copied into the store; a URL without one gets the stored view written in.
 * Leaving the tab needs no cleanup: useAdminTabUrlSync drops these keys through the param registry.
 */
export const useOrganizationsTabUrlSync = (): void => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => organizationsViewFromSearch(search), [search]);
  // On back/forward to another tab the URL changes a render before this tab unmounts; never write
  // this view onto another tab's URL. A bare `/admin` is picked up once the tab sync names us.
  const isOrganizationsTabUrl = search[ADMIN_TAB_PARAM] === ADMIN_ORGANIZATIONS_TAB_SLUG;

  useEffect(() => {
    if (!isOrganizationsTabUrl) return;
    const { params: storedParams, setParams: setStoredParams } = useOrganizationsTab.getState();
    if (urlView) {
      if (!isSameOrganizationsView(urlView, storedParams)) setStoredParams(urlView);
      return;
    }
    navigate({ to: ADMIN_PATH, search: writeStoredViewToUrl, replace: true });
  }, [isOrganizationsTabUrl, urlView, navigate]);
};

/** The organization open in the profile modal, kept in `?orgId=` so a refresh or a link reopens it. */
export const useOpenOrganizationId = () => {
  const orgId = useSearch({
    strict: false,
    select: search => (search as SearchRecord)[ORGS_ORG_ID_PARAM],
  });
  const navigate = useNavigate();

  const setOrgId = useCallback(
    (id: string | null) =>
      navigate({
        to: ADMIN_PATH,
        search: (previous: SearchRecord) => ({ ...previous, [ORGS_ORG_ID_PARAM]: id ?? undefined }),
        // No history entry, like the Users tab's `userId`: Back leaves /admin rather than closing.
        replace: true,
      }),
    [navigate]
  );

  return { orgId: typeof orgId === 'string' ? orgId : null, setOrgId };
};
