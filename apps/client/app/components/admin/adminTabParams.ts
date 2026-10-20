import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  ADMIN_FEEDBACK_TAB_SLUG,
  ADMIN_TAB_PARAM,
  AUDIT_ENTRY_ID_PARAM,
  AuditLogFiltersSchema,
  FEEDBACK_ID_PARAM,
  type AuditLogFilters,
} from '@bike4mind/common';

/**
 * Which `/admin` search params belong to which tab - the one list both the admin route's
 * `validateSearch` (router.tsx) and the tab-sync hook's rebuild (useAdminTabUrlSync.ts) read, so a
 * tab that keeps state in the URL registers its keys here and nowhere else.
 *
 * Deliberately free of AdminTab and the sidebar config: router.tsx imports this eagerly, and the
 * sidebar config drags in every admin icon. adminTabParams.test.ts checks each key is a real slug.
 */

export const ADMIN_SETTINGS_TAB_SLUG = 'admin-settings';
export const ADMIN_SETTINGS_SECTION_PARAM = 'section';
export const ADMIN_SETTINGS_SEARCH_PARAM = 'q';

const EMERGENCY_ACCESS_PARAM = 'emergency_access';

const AUDIT_LOG_FILTER_PARAMS = Object.keys(AuditLogFiltersSchema.shape) as Array<keyof AuditLogFilters>;

/** Console-wide params: they survive every tab change. */
export const ADMIN_GLOBAL_PARAMS = [EMERGENCY_ACCESS_PARAM, ADMIN_TAB_PARAM] as const;

/**
 * Tab slug -> the params that tab owns. A key must be owned by exactly one tab (the test enforces
 * it): a shared name would carry one tab's value into the other on a tab switch. These URLs get
 * pasted into Slack and copied into login redirects, so never register tokens, form fields, setting
 * values, or a search box over user records (emails, names). Admin Settings' `q` is the accepted
 * exception: it searches platform config, not people.
 */
export const ADMIN_TAB_PARAMS = {
  [ADMIN_FEEDBACK_TAB_SLUG]: [FEEDBACK_ID_PARAM],
  [ADMIN_AUDIT_LOG_TAB_SLUG]: [...AUDIT_LOG_FILTER_PARAMS, AUDIT_ENTRY_ID_PARAM],
  [ADMIN_SETTINGS_TAB_SLUG]: [ADMIN_SETTINGS_SECTION_PARAM, ADMIN_SETTINGS_SEARCH_PARAM],
} as const satisfies Readonly<Record<string, readonly string[]>>;

type AdminTabParam = (typeof ADMIN_TAB_PARAMS)[keyof typeof ADMIN_TAB_PARAMS][number];
type AdminSearchParam = (typeof ADMIN_GLOBAL_PARAMS)[number] | AdminTabParam;

export type AdminSearch = Partial<Record<AdminSearchParam, string>>;

// A Map for the same reason as adminTabSlugs.ts: the slug comes from the query string, and an
// object lookup would resolve `?tab=constructor` to an inherited member.
const PARAMS_BY_TAB_SLUG: ReadonlyMap<string, readonly AdminTabParam[]> = new Map(Object.entries(ADMIN_TAB_PARAMS));

const ALL_ADMIN_SEARCH_PARAMS: readonly AdminSearchParam[] = [
  ...ADMIN_GLOBAL_PARAMS,
  ...Object.values(ADMIN_TAB_PARAMS).flat(),
];

/**
 * Strings only, `String()`-coercing the values TanStack's JSON search parser turned into numbers.
 * Must stay in sync with `optionalStringParam` in router.tsx (same rule; importing from there would
 * be a cycle).
 */
const optionalString = (value: unknown): string | undefined => (value ? String(value) : undefined);

/**
 * The admin route's `validateSearch`. Every registered key is declared (absent ones as undefined),
 * so each tab's params are typed and survive validation.
 */
export function parseAdminSearch(search: Record<string, unknown>): AdminSearch {
  return Object.fromEntries(ALL_ADMIN_SEARCH_PARAMS.map(key => [key, optionalString(search[key])]));
}

/**
 * The search to write when the console switches to `slug`: the console-wide params plus only that
 * tab's own, so the previous tab's state and stray params (a leftover login redirectTo) are dropped.
 * Every other registered key is set to undefined rather than omitted, so it is removed from the URL.
 */
export function adminSearchForTab(previous: Record<string, unknown>, slug: string): AdminSearch {
  const kept = new Set<string>([...ADMIN_GLOBAL_PARAMS, ...(PARAMS_BY_TAB_SLUG.get(slug) ?? [])]);
  const search = Object.fromEntries(
    ALL_ADMIN_SEARCH_PARAMS.map(key => [key, kept.has(key) ? optionalString(previous[key]) : undefined])
  ) as AdminSearch;
  return { ...search, [ADMIN_TAB_PARAM]: slug };
}
