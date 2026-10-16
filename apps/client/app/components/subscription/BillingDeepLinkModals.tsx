import BillingModal from '@client/app/components/subscription/BillingModal';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import {
  BILLING_SEARCH_PARAM,
  type BillingView,
  parseBillingView,
  withBillingView,
} from '@client/app/utils/billingDeepLink';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';

/** History-state flag for an open that did not ask for a section (the account menu's Billing row). */
const OVERVIEW_STATE_KEY = 'billingOverview';

/**
 * The billing view named by the current URL's `?billing=` param, plus setters that write it.
 * Opening pushes a history entry (Back closes the modal); closing replaces it so the closed
 * modal is not a Back target.
 *
 * `focusSection` is false only for an in-app open made with `{ focusSection: false }`. The flag lives
 * in history state, not the URL, so a pasted or shared `?billing=` link still lands on its section.
 */
export function useBillingView() {
  const router = useRouter();
  const location = useRouterState({ select: state => state.location });
  const view = parseBillingView((location.search as Record<string, unknown>)[BILLING_SEARCH_PARAM]);
  const focusSection = !(location.state as unknown as Record<string, unknown> | undefined)?.[OVERVIEW_STATE_KEY];

  const hrefFor = useCallback(
    (next: BillingView | undefined) => {
      const { pathname, searchStr, hash } = router.state.location;
      return `${pathname}${withBillingView(searchStr, next)}${hash ? `#${hash}` : ''}`;
    },
    [router]
  );

  const openView = useCallback(
    (next: BillingView, options: { focusSection?: boolean } = {}) =>
      router.history.push(hrefFor(next), options.focusSection === false ? { [OVERVIEW_STATE_KEY]: true } : undefined),
    [router, hrefFor]
  );
  const closeView = useCallback(() => router.history.replace(hrefFor(undefined)), [router, hrefFor]);

  return { view, focusSection, openView, closeView };
}

/**
 * App-shell host for the billing modal, opened by `?billing=credits|plans` (the section it lands on). Mounted
 * once in the layout route (router.tsx); the profile menu opens it by writing the same param,
 * so every open state has a URL.
 */
const BillingDeepLinkModals = () => {
  const { view, focusSection, closeView } = useBillingView();
  const isCreditsEnabled = !!useGetSettingsValue('enforceCredits');

  return <BillingModal open={isCreditsEnabled && !!view} focus={focusSection ? view : undefined} onClose={closeView} />;
};

export default BillingDeepLinkModals;
