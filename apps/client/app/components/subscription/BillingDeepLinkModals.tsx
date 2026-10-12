import CreditsModal from '@client/app/components/subscription/CreditsModal';
import SubscriptionModal from '@client/app/components/subscription/SubscriptionModal';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import {
  BILLING_SEARCH_PARAM,
  type BillingView,
  parseBillingView,
  withBillingView,
} from '@client/app/utils/billingDeepLink';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useCallback } from 'react';

/**
 * The billing view named by the current URL's `?billing=` param, plus setters that write it.
 * Opening pushes a history entry (Back closes the modal); closing replaces it so the closed
 * modal is not a Back target.
 */
export function useBillingView() {
  const router = useRouter();
  const location = useRouterState({ select: state => state.location });
  const view = parseBillingView((location.search as Record<string, unknown>)[BILLING_SEARCH_PARAM]);

  const hrefFor = useCallback(
    (next: BillingView | undefined) => {
      const { pathname, searchStr, hash } = router.state.location;
      return `${pathname}${withBillingView(searchStr, next)}${hash ? `#${hash}` : ''}`;
    },
    [router]
  );

  const openView = useCallback((next: BillingView) => router.history.push(hrefFor(next)), [router, hrefFor]);
  const closeView = useCallback(() => router.history.replace(hrefFor(undefined)), [router, hrefFor]);

  return { view, openView, closeView };
}

/**
 * App-shell host for the credits and plans modals, opened by `?billing=credits|plans`. Mounted
 * once in the layout route (router.tsx); the profile menu opens them by writing the same param,
 * so every open state has a URL.
 */
const BillingDeepLinkModals = () => {
  const { view, closeView } = useBillingView();
  const isCreditsEnabled = !!useGetSettingsValue('enforceCredits');

  return (
    <>
      <CreditsModal open={isCreditsEnabled && view === 'credits'} onClose={closeView} />
      <SubscriptionModal open={isCreditsEnabled && view === 'plans'} onClose={closeView} />
    </>
  );
};

export default BillingDeepLinkModals;
