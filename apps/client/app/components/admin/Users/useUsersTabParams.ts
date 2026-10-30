import { ADMIN_TAB_PARAM, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  DEFAULT_USERS_PARAMS,
  USERS_FILTER_KEYS,
  isSameUsersView,
  migrateStoredUsersParams,
  usersViewFromSearch,
  usersViewToSearch,
  type UsersListParams,
} from './usersTabSearch';

export { DEFAULT_USERS_PARAMS, PAGE_LIMIT_OPTIONS } from './usersTabSearch';

const ADMIN_PATH = '/admin';

// Persist key must stay 'admin-user-tab-01': changing it silently discards every admin's saved
// filters. Version 1 is the rebuilt list; `migrate` carries a version 0 copy across.
export const useUsersTab = create<{
  params: UsersListParams;
  setParams: (params: Partial<UsersListParams>) => void;
}>()(
  persist(
    (set, get) => ({
      params: { ...DEFAULT_USERS_PARAMS },
      setParams: params => set({ params: { ...get().params, ...params } }),
    }),
    {
      name: 'admin-user-tab-01',
      version: 1,
      partialize: state => ({ params: state.params }),
      migrate: persisted => {
        const params = (persisted as { params?: unknown } | null)?.params;
        return {
          params: migrateStoredUsersParams(typeof params === 'object' && params !== null ? { ...params } : {}),
        };
      },
    }
  )
);

type SearchRecord = Record<string, unknown>;

const VIEW_KEYS = ['page', 'limit', 'sortField', 'sortOrder', 'orgSearch', 'tags', 'groupBy', ...USERS_FILTER_KEYS];

const touchesView = (patch: Partial<UsersListParams>) => VIEW_KEYS.some(key => key in patch);

/**
 * The Users tab's list params. The URL owns the view (page, limit, sort, org and tag filters) when it
 * carries one; the persisted store holds the free-text search, which never enters the URL, and a copy
 * of the view so a bare `?tab=users` restores the last one. Every write goes to both, with `replace`.
 */
export const useUsersParams = (): readonly [UsersListParams, (patch: Partial<UsersListParams>) => void] => {
  const [storedParams, setStoredParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => usersViewFromSearch(search), [search]);

  const params = useMemo(() => (urlView ? { ...storedParams, ...urlView } : storedParams), [storedParams, urlView]);

  const setParams = useCallback(
    (patch: Partial<UsersListParams>) => {
      setStoredParams(patch);
      if (!touchesView(patch)) return;
      // Written from the store, which useUsersTabUrlSync keeps level with the URL and which already
      // holds this patch merged into the full view, so the URL always carries a complete view.
      navigate({
        to: ADMIN_PATH,
        search: (previous: SearchRecord) => ({ ...previous, ...usersViewToSearch(useUsersTab.getState().params) }),
        replace: true,
      });
    },
    [navigate, setStoredParams]
  );

  return [params, setParams] as const;
};

/**
 * Reconciles the URL and the persisted store while the Users tab is mounted. A URL that describes a
 * view wins and is copied into the store (so the next bare visit restores it); a URL with no view
 * gets the stored one written in. Leaving the tab needs no cleanup: the tab-sync rebuild in
 * useAdminTabUrlSync drops these keys through the param registry.
 */
export const useUsersTabUrlSync = (): void => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => usersViewFromSearch(search), [search]);
  // On back/forward to another tab the URL changes a render before this tab unmounts; never write
  // the Users view onto another tab's URL. A bare `/admin` is picked up once the tab sync names us.
  const isUsersTabUrl = search[ADMIN_TAB_PARAM] === ADMIN_USERS_TAB_SLUG;

  useEffect(() => {
    if (!isUsersTabUrl) return;
    const { params: storedParams, setParams: setStoredParams } = useUsersTab.getState();
    if (urlView) {
      if (!isSameUsersView(urlView, storedParams)) setStoredParams(urlView);
      return;
    }
    navigate({
      to: ADMIN_PATH,
      search: (previous: SearchRecord) => ({ ...previous, ...usersViewToSearch(useUsersTab.getState().params) }),
      replace: true,
    });
  }, [isUsersTabUrl, urlView, navigate]);
};
