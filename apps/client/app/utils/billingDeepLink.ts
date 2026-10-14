/**
 * Deep links into the billing UIs. The credits and plans modals are driven by a `?billing=`
 * search param on any app-shell page (see components/subscription/BillingDeepLinkModals), and
 * `/billing/<view>` is the short, shareable entry point that forwards to it. External links use
 * `/billing/<view>` because the layout login guard drops `redirectTo` for a bare `/`, so
 * `/?billing=plans` would not survive a sign-in.
 */

export const BILLING_SEARCH_PARAM = 'billing';

export const BILLING_VIEWS = ['credits', 'plans'] as const;

export type BillingView = (typeof BILLING_VIEWS)[number];

export function parseBillingView(value: unknown): BillingView | undefined {
  return BILLING_VIEWS.find(view => view === value);
}

/** Returns `searchStr` with the billing param set to `view`, or removed when `view` is undefined. */
export function withBillingView(searchStr: string, view: BillingView | undefined): string {
  const params = new URLSearchParams(searchStr);
  if (view) {
    params.set(BILLING_SEARCH_PARAM, view);
  } else {
    params.delete(BILLING_SEARCH_PARAM);
  }
  const next = params.toString();
  return next ? `?${next}` : '';
}

/** In-app target a `/billing/<view>` link forwards to. */
export function billingLandingHref(view: BillingView | undefined): string {
  return `/new${withBillingView('', view)}`;
}
