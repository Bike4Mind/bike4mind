import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import {
  ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  DEFAULT_SUBSCRIPTIONS_PARAMS,
  SUBSCRIPTIONS_FILTER_KEYS,
  isSameSubscriptionsView,
  subscriptionsViewFromSearch,
  subscriptionsViewToSearch,
  type SubscriptionsListParams,
} from './subscriptionsTabSearch';

const ADMIN_PATH = '/admin';

// Persist key must stay 'admin-subscriptions-tab-01': changing it silently discards every admin's
// saved view.
export const useSubscriptionsTab = create<{
  params: SubscriptionsListParams;
  setParams: (params: Partial<SubscriptionsListParams>) => void;
}>()(
  persist(
    (set, get) => ({
      params: { ...DEFAULT_SUBSCRIPTIONS_PARAMS },
      setParams: params => set({ params: { ...get().params, ...params } }),
    }),
    { name: 'admin-subscriptions-tab-01', partialize: state => ({ params: state.params }) }
  )
);

type SearchRecord = Record<string, unknown>;

const VIEW_KEYS = ['page', 'limit', 'sortField', 'sortOrder', ...SUBSCRIPTIONS_FILTER_KEYS];

const touchesView = (patch: Partial<SubscriptionsListParams>) => VIEW_KEYS.some(key => key in patch);

const writeStoredViewToUrl = (previous: SearchRecord): SearchRecord => ({
  ...previous,
  ...subscriptionsViewToSearch(useSubscriptionsTab.getState().params),
});

/**
 * The URL owns the list view when it carries one; the persisted store holds the free-text search,
 * which never enters the URL, and a copy of the view for a bare `?tab=subscriptions`. Every write
 * goes to both, with `replace`.
 */
export const useSubscriptionsParams = (): readonly [
  SubscriptionsListParams,
  (patch: Partial<SubscriptionsListParams>) => void,
] => {
  const [storedParams, setStoredParams] = useSubscriptionsTab(useShallow(state => [state.params, state.setParams]));
  const router = useRouter();
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => subscriptionsViewFromSearch(search), [search]);

  const params = useMemo(() => (urlView ? { ...storedParams, ...urlView } : storedParams), [storedParams, urlView]);

  const setParams = useCallback(
    (patch: Partial<SubscriptionsListParams>) => {
      setStoredParams(patch);
      if (!touchesView(patch)) return;
      // The debounced search can land after the tab unmounts; never write this view onto another tab.
      const { pathname, search: current } = router.state.location;
      if (pathname !== ADMIN_PATH || (current as SearchRecord)[ADMIN_TAB_PARAM] !== ADMIN_SUBSCRIPTIONS_TAB_SLUG)
        return;
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
export const useSubscriptionsTabUrlSync = (): void => {
  const search = useSearch({ strict: false }) as SearchRecord;
  const navigate = useNavigate();
  const urlView = useMemo(() => subscriptionsViewFromSearch(search), [search]);
  // On back/forward to another tab the URL changes a render before this tab unmounts.
  const isSubscriptionsTabUrl = search[ADMIN_TAB_PARAM] === ADMIN_SUBSCRIPTIONS_TAB_SLUG;

  useEffect(() => {
    if (!isSubscriptionsTabUrl) return;
    const { params: storedParams, setParams: setStoredParams } = useSubscriptionsTab.getState();
    if (urlView) {
      if (!isSameSubscriptionsView(urlView, storedParams)) setStoredParams(urlView);
      return;
    }
    navigate({ to: ADMIN_PATH, search: writeStoredViewToUrl, replace: true });
  }, [isSubscriptionsTabUrl, urlView, navigate]);
};
