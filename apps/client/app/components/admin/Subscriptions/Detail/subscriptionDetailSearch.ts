/**
 * The search params of `/admin/subscriptions/$subscriptionId`. Pure and React-free, because router.tsx
 * imports it eagerly. Mirrors userProfileSearch.ts.
 */

export const SUBSCRIPTION_DETAIL_TABS = ['overview', 'admin'] as const;

export type SubscriptionDetailTab = (typeof SUBSCRIPTION_DETAIL_TABS)[number];

export const DEFAULT_SUBSCRIPTION_DETAIL_TAB: SubscriptionDetailTab = 'overview';

export const SUBSCRIPTION_DETAIL_TAB_LABELS: Readonly<Record<SubscriptionDetailTab, string>> = {
  overview: 'Overview',
  admin: 'Admin log',
};

export type SubscriptionDetailSearch = { tab?: SubscriptionDetailTab };

export const isSubscriptionDetailTab = (value: unknown): value is SubscriptionDetailTab =>
  typeof value === 'string' && (SUBSCRIPTION_DETAIL_TABS as readonly string[]).includes(value);

/**
 * The route's `validateSearch`. The default tab stays out of the URL, and a dropped tab is an explicit
 * `undefined` so the root's raw search cannot leak `?tab=nonsense` through (see parseUserProfileSearch).
 */
export const parseSubscriptionDetailSearch = (search: Record<string, unknown>): SubscriptionDetailSearch => {
  const tab = search.tab;
  return { tab: isSubscriptionDetailTab(tab) && tab !== DEFAULT_SUBSCRIPTION_DETAIL_TAB ? tab : undefined };
};
