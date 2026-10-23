/**
 * The search params of `/admin/users/$userId`. Pure and React-free, because router.tsx imports it
 * eagerly. Tabs from later work register here by adding a slug.
 */

export const USER_PROFILE_TABS = ['overview', 'activity', 'admin'] as const;

export type UserProfileTab = (typeof USER_PROFILE_TABS)[number];

export const DEFAULT_USER_PROFILE_TAB: UserProfileTab = 'overview';

export const USER_PROFILE_TAB_LABELS: Readonly<Record<UserProfileTab, string>> = {
  overview: 'Overview',
  activity: 'Activity',
  admin: 'Admin',
};

export type UserProfileSearch = { tab?: UserProfileTab };

export const isUserProfileTab = (value: unknown): value is UserProfileTab =>
  typeof value === 'string' && (USER_PROFILE_TABS as readonly string[]).includes(value);

/** The route's `validateSearch`. The default tab is left out of the URL to keep links short. */
export const parseUserProfileSearch = (search: Record<string, unknown>): UserProfileSearch => {
  const tab = search.tab;
  return isUserProfileTab(tab) && tab !== DEFAULT_USER_PROFILE_TAB ? { tab } : {};
};

/**
 * Where an old `/admin?userId=` link goes now that the user view is a page, or undefined when the
 * URL holds no (valid) user. adminRoute's beforeLoad throws it as a redirect.
 */
export const legacyUserLinkRedirect = (search: { userId?: string }) =>
  search.userId ? { to: '/admin/users/$userId' as const, params: { userId: search.userId }, replace: true } : undefined;
