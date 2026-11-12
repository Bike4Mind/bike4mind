import { useCallback, useMemo, useState } from 'react';
import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import {
  ADMIN_REVENUE_TAB_SLUG,
  REVENUE_VIEW_PARAM,
  paymentsParamsFromSearch,
  paymentsParamsToSearch,
  revenueViewFromSearch,
  type PaymentsParams,
  type RevenueView,
} from '../revenueTabSearch';

const ADMIN_PATH = '/admin';
type SearchRecord = Record<string, unknown>;

/**
 * Writes a patch to the Revenue tab's URL, with `replace`. A write that lands after the admin has left
 * the tab (the debounced search, a late click) is dropped rather than written onto another tab.
 */
function useRevenueSearchWriter(): (patch: SearchRecord) => void {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    (patch: SearchRecord) => {
      const { pathname, search } = router.state.location;
      if (pathname !== ADMIN_PATH || (search as SearchRecord)[ADMIN_TAB_PARAM] !== ADMIN_REVENUE_TAB_SLUG) return;
      void navigate({ to: ADMIN_PATH, search: (previous: SearchRecord) => ({ ...previous, ...patch }), replace: true });
    },
    [navigate, router]
  );
}

export function useRevenueView(): readonly [RevenueView, (view: RevenueView) => void] {
  const search = useSearch({ strict: false }) as SearchRecord;
  const write = useRevenueSearchWriter();
  const view = revenueViewFromSearch(search);
  const setView = useCallback(
    // The default view is left out of the URL to keep links short.
    (next: RevenueView) => write({ [REVENUE_VIEW_PARAM]: next === 'subscriptions' ? undefined : next }),
    [write]
  );
  return [view, setView] as const;
}

/**
 * The Payments filters: the URL owns them, so a link reopens the same view. A URL without a range gets
 * the last 30 UTC days as of when the view opened.
 */
export function usePaymentsParams(): readonly [PaymentsParams, (patch: Partial<PaymentsParams>) => void] {
  const search = useSearch({ strict: false }) as SearchRecord;
  const write = useRevenueSearchWriter();
  const [openedAt] = useState(() => new Date());
  const params = useMemo(() => paymentsParamsFromSearch(search, openedAt), [search, openedAt]);
  const setParams = useCallback(
    (patch: Partial<PaymentsParams>) => write({ ...paymentsParamsToSearch(patch) }),
    [write]
  );
  return [params, setParams] as const;
}
