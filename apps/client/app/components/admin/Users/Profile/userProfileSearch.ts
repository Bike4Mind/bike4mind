/**
 * The search params of `/admin/users/$userId`. Pure and React-free, because router.tsx imports it
 * eagerly. Tabs from later work register here by adding a slug.
 */

import { DEFAULT_BILLING_RANGE, isBillingRange, type BillingRange } from '@client/app/utils/adminBillingOverview';
import { parseActivitySearch, type ActivitySearch } from './activitySearch';

export const USER_PROFILE_TABS = ['overview', 'activity', 'credits', 'billing', 'keys', 'signins', 'admin'] as const;

export type UserProfileTab = (typeof USER_PROFILE_TABS)[number];

export const DEFAULT_USER_PROFILE_TAB: UserProfileTab = 'overview';

export const USER_PROFILE_TAB_LABELS: Readonly<Record<UserProfileTab, string>> = {
  overview: 'Overview',
  activity: 'Activity',
  credits: 'Credits',
  billing: 'Billing',
  keys: 'API keys',
  signins: 'Sign-ins',
  admin: 'Admin log',
};

/** `range` belongs to the Billing tab; the default window is left out of the URL. */
export type UserProfileSearch = { tab?: UserProfileTab; range?: BillingRange } & ActivitySearch;

export const isUserProfileTab = (value: unknown): value is UserProfileTab =>
  typeof value === 'string' && (USER_PROFILE_TABS as readonly string[]).includes(value);

/**
 * The route's `validateSearch`. The default tab is left out of the URL to keep links short.
 * A dropped tab is returned as an explicit `undefined`: TanStack Router builds a child route's search
 * as `{ ...parentSearch, ...validated }`, and the root's search is the raw query, so omitting the key
 * would let `?tab=nonsense` through to the page.
 */
export const parseUserProfileSearch = (search: Record<string, unknown>): UserProfileSearch => {
  const tab = search.tab;
  // Filters belong to the Activity tab; any other tab drops them explicitly (see above).
  const activity =
    tab === 'activity' ? parseActivitySearch(search) : { types: undefined, from: undefined, to: undefined };
  const range =
    tab === 'billing' && isBillingRange(search.range) && search.range !== DEFAULT_BILLING_RANGE
      ? search.range
      : undefined;
  return { tab: isUserProfileTab(tab) && tab !== DEFAULT_USER_PROFILE_TAB ? tab : undefined, ...activity, range };
};

/**
 * Where an old `/admin?userId=` link goes now that the user view is a page, or undefined when the
 * URL holds no (valid) user. adminRoute's beforeLoad throws it as a redirect.
 */
export const legacyUserLinkRedirect = (search: { userId?: string }) =>
  search.userId ? { to: '/admin/users/$userId' as const, params: { userId: search.userId }, replace: true } : undefined;
