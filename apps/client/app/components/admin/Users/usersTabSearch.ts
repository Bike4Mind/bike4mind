import { USER_ID_PARAM } from '@bike4mind/common';
import {
  ADMIN_USERS_PAGE_SIZES,
  ADMIN_USERS_SORT_FIELDS,
  USER_PLAN_FILTERS,
  USER_RISK_FILTERS,
  USER_SIGNED_UP_FILTERS,
  USER_SIGNUP_METHOD_FILTERS,
  USER_STATUS_FILTERS,
  YES_NO_FILTERS,
  type AdminUsersFilter,
  type AdminUsersSortField,
} from '@client/app/utils/adminUsersFilter';
import { oneOf, parsePage, parseStringList, toNumber } from '../adminSearchValues';

/**
 * The Users tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it. The free-text `search` box is deliberately
 * absent - it usually holds an email, and these URLs get shared and copied into login redirects.
 */

export const PAGE_LIMIT_OPTIONS: readonly number[] = ADMIN_USERS_PAGE_SIZES;

const SORT_ORDERS = ['asc', 'desc'] as const;

/** The list view: everything but the free-text search. */
export type UsersListView = Omit<AdminUsersFilter, 'search'> & {
  page: number;
  limit: number;
  sortField: AdminUsersSortField;
  sortOrder: (typeof SORT_ORDERS)[number];
  orgSearch: string[];
  tags: string[];
  groupBy?: 'emailDomain';
};
export type UsersListParams = UsersListView & { search: string };

export const DEFAULT_USERS_PARAMS: UsersListParams = {
  page: 1,
  limit: 25,
  search: '',
  sortField: 'createdAt',
  sortOrder: 'desc',
  orgSearch: ['all'],
  tags: [],
};

/** The single-choice filters: list param -> URL param. */
export const USERS_FILTER_PARAMS = {
  status: 'status',
  plan: 'plan',
  emailDomain: 'domain',
  signupMethod: 'method',
  verified: 'verified',
  hasApiKey: 'keys',
  signedUp: 'signedUp',
  risk: 'risk',
  createdFrom: 'createdFrom',
  createdTo: 'createdTo',
} as const satisfies Partial<Record<keyof UsersListView, string>>;
export type UsersFilterKey = keyof typeof USERS_FILTER_PARAMS;
export const USERS_FILTER_KEYS = Object.keys(USERS_FILTER_PARAMS) as UsersFilterKey[];

export const USERS_PAGE_PARAM = 'page';
export const USERS_LIMIT_PARAM = 'limit';
export const USERS_SORT_PARAM = 'sort';
export const USERS_ORDER_PARAM = 'order';
export const USERS_ORG_PARAM = 'org';
export const USERS_TAGS_PARAM = 'tags';
export const USERS_USER_ID_PARAM = USER_ID_PARAM;
/** Read only, so links from before the Signed up filter still open the last-hour view. */
const LEGACY_RECENT_SIGNUPS_PARAM = 'recentSignups';

const USERS_VIEW_PARAMS = [
  USERS_PAGE_PARAM,
  USERS_LIMIT_PARAM,
  USERS_SORT_PARAM,
  USERS_ORDER_PARAM,
  USERS_ORG_PARAM,
  USERS_TAGS_PARAM,
  'groupBy',
  LEGACY_RECENT_SIGNUPS_PARAM,
  ...Object.values(USERS_FILTER_PARAMS),
] as const;

/**
 * `userId` is separate: it is only read, so that the old `/admin?userId=` links can redirect to
 * `/admin/users/$userId` (adminRoute's beforeLoad).
 */
export const USERS_TAB_PARAMS = [...USERS_VIEW_PARAMS, USERS_USER_ID_PARAM] as const;

export type UsersSearch = {
  [USERS_PAGE_PARAM]?: number;
  [USERS_LIMIT_PARAM]?: number;
  [USERS_SORT_PARAM]?: AdminUsersSortField;
  [USERS_ORDER_PARAM]?: (typeof SORT_ORDERS)[number];
  [USERS_ORG_PARAM]?: string[];
  [USERS_TAGS_PARAM]?: string[];
  [USERS_USER_ID_PARAM]?: string;
  groupBy?: 'emailDomain';
  [LEGACY_RECENT_SIGNUPS_PARAM]?: 'hour';
  status?: UsersListView['status'];
  // Another route declares `plan` as a plain string and TanStack merges search types across routes;
  // the parser still only yields a known plan.
  plan?: string;
  domain?: string;
  method?: UsersListView['signupMethod'];
  verified?: UsersListView['verified'];
  keys?: UsersListView['hasApiKey'];
  signedUp?: UsersListView['signedUp'];
  risk?: UsersListView['risk'];
  createdFrom?: string;
  createdTo?: string;
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return PAGE_LIMIT_OPTIONS.includes(limit) ? limit : undefined;
};

// Only a full ISO instant, normalized, so a link cannot smuggle a free-form date string to the API.
export const parseInstant = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};

// Mirrors AdminUsersFilterSchema.emailDomain, so a link can never carry a domain the API rejects.
export const parseDomain = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(domain) ? domain : undefined;
};

// The id is interpolated into `/api/users/<id>`, so only an ObjectId may come in from a link.
export const parseUserId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) ? value : undefined;

// A view param that fails to parse still asked for a view. Keeping the default page stops
// `validateSearch` from reducing `?sort=bogus` to a bare visit that restores the saved view.
const parseUsersPage = (value: unknown, search: Record<string, unknown> = {}): number | undefined =>
  parsePage(value) ??
  (USERS_VIEW_PARAMS.some(key => search[key] !== undefined) ? DEFAULT_USERS_PARAMS.page : undefined);

/**
 * Per-key coercion for the route's `validateSearch`, given the whole raw search as well; anything
 * invalid becomes undefined.
 */
const parsePlan = oneOf(USER_PLAN_FILTERS);

export const USERS_SEARCH_PARSERS: {
  readonly [K in keyof UsersSearch]-?: (value: unknown, search?: Record<string, unknown>) => UsersSearch[K];
} = {
  [USERS_PAGE_PARAM]: parseUsersPage,
  [USERS_LIMIT_PARAM]: parseLimit,
  [USERS_SORT_PARAM]: oneOf(ADMIN_USERS_SORT_FIELDS),
  [USERS_ORDER_PARAM]: oneOf(SORT_ORDERS),
  [USERS_ORG_PARAM]: parseStringList,
  [USERS_TAGS_PARAM]: parseStringList,
  [USERS_USER_ID_PARAM]: parseUserId,
  groupBy: oneOf(['emailDomain'] as const),
  [LEGACY_RECENT_SIGNUPS_PARAM]: oneOf(['hour'] as const),
  status: oneOf(USER_STATUS_FILTERS),
  plan: parsePlan,
  domain: parseDomain,
  method: oneOf(USER_SIGNUP_METHOD_FILTERS),
  verified: oneOf(YES_NO_FILTERS),
  keys: oneOf(YES_NO_FILTERS),
  signedUp: oneOf(USER_SIGNED_UP_FILTERS),
  risk: oneOf(USER_RISK_FILTERS),
  createdFrom: parseInstant,
  createdTo: parseInstant,
};

function filtersFromSearch(search: Record<string, unknown>): Pick<UsersListView, UsersFilterKey> {
  return {
    status: USERS_SEARCH_PARSERS.status(search.status),
    plan: parsePlan(search.plan),
    emailDomain: USERS_SEARCH_PARSERS.domain(search.domain),
    signupMethod: USERS_SEARCH_PARSERS.method(search.method),
    verified: USERS_SEARCH_PARSERS.verified(search.verified),
    hasApiKey: USERS_SEARCH_PARSERS.keys(search.keys),
    signedUp:
      USERS_SEARCH_PARSERS.signedUp(search.signedUp) ??
      USERS_SEARCH_PARSERS[LEGACY_RECENT_SIGNUPS_PARAM](search[LEGACY_RECENT_SIGNUPS_PARAM]),
    risk: USERS_SEARCH_PARSERS.risk(search.risk),
    createdFrom: parseInstant(search.createdFrom),
    createdTo: parseInstant(search.createdTo),
  };
}

/**
 * The list view a URL describes, or undefined when it carries none of the view params (a bare
 * `?tab=users`, which restores the last view from localStorage). When any view param is present the
 * URL describes the whole view and a missing one means its default, so a shared link never picks up
 * the recipient's saved filters.
 */
export function usersViewFromSearch(search: Record<string, unknown>): UsersListView | undefined {
  const parsed = {
    page: parsePage(search[USERS_PAGE_PARAM]),
    limit: parseLimit(search[USERS_LIMIT_PARAM]),
    sortField: USERS_SEARCH_PARSERS[USERS_SORT_PARAM](search[USERS_SORT_PARAM]),
    sortOrder: USERS_SEARCH_PARSERS[USERS_ORDER_PARAM](search[USERS_ORDER_PARAM]),
    orgSearch: parseStringList(search[USERS_ORG_PARAM]),
    tags: parseStringList(search[USERS_TAGS_PARAM]),
    groupBy: USERS_SEARCH_PARSERS.groupBy(search.groupBy),
    ...filtersFromSearch(search),
  };
  if (Object.values(parsed).every(value => value === undefined)) return undefined;
  // Unset filters stay as explicit undefined keys, so spreading a view over stored params clears them.
  return {
    ...parsed,
    page: parsed.page ?? DEFAULT_USERS_PARAMS.page,
    limit: parsed.limit ?? DEFAULT_USERS_PARAMS.limit,
    sortField: parsed.sortField ?? DEFAULT_USERS_PARAMS.sortField,
    sortOrder: parsed.sortOrder ?? DEFAULT_USERS_PARAMS.sortOrder,
    orgSearch: parsed.orgSearch ?? DEFAULT_USERS_PARAMS.orgSearch,
    tags: parsed.tags ?? DEFAULT_USERS_PARAMS.tags,
  };
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * The view params to write for `params`. Defaults are left out to keep links short, except `page`,
 * which is always written so every Users URL carries a view param and reads back as a whole view
 * (see usersViewFromSearch) rather than as "restore from localStorage".
 */
export function usersViewToSearch(params: UsersListView): Omit<UsersSearch, typeof USERS_USER_ID_PARAM> {
  const unlessDefault = <T>(value: T, isDefault: boolean): T | undefined => (isDefault ? undefined : value);
  return {
    [USERS_PAGE_PARAM]: parsePage(params.page) ?? DEFAULT_USERS_PARAMS.page,
    [USERS_LIMIT_PARAM]: unlessDefault(parseLimit(params.limit), params.limit === DEFAULT_USERS_PARAMS.limit),
    [USERS_SORT_PARAM]: unlessDefault(
      USERS_SEARCH_PARSERS[USERS_SORT_PARAM](params.sortField),
      params.sortField === DEFAULT_USERS_PARAMS.sortField
    ),
    [USERS_ORDER_PARAM]: unlessDefault(
      USERS_SEARCH_PARSERS[USERS_ORDER_PARAM](params.sortOrder),
      params.sortOrder === DEFAULT_USERS_PARAMS.sortOrder
    ),
    [USERS_ORG_PARAM]: unlessDefault(
      parseStringList(params.orgSearch),
      sameList(params.orgSearch, DEFAULT_USERS_PARAMS.orgSearch)
    ),
    [USERS_TAGS_PARAM]: parseStringList(params.tags),
    groupBy: params.groupBy,
    [LEGACY_RECENT_SIGNUPS_PARAM]: undefined,
    status: params.status,
    plan: params.plan,
    domain: params.emailDomain,
    method: params.signupMethod,
    verified: params.verified,
    keys: params.hasApiKey,
    signedUp: params.signedUp,
    risk: params.risk,
    createdFrom: parseInstant(params.createdFrom),
    createdTo: parseInstant(params.createdTo),
  };
}

/** Whether two param sets describe the same list view (the free-text search is not compared). */
export function isSameUsersView(a: UsersListView, b: UsersListView): boolean {
  return (
    a.page === b.page &&
    a.limit === b.limit &&
    a.sortField === b.sortField &&
    a.sortOrder === b.sortOrder &&
    sameList(a.orgSearch, b.orgSearch) &&
    sameList(a.tags, b.tags) &&
    a.groupBy === b.groupBy &&
    USERS_FILTER_KEYS.every(key => a[key] === b[key])
  );
}

/** Every filter cleared: what "Clear filters" and the All view apply. Keeps sort, page size and grouping. */
export const CLEARED_FILTER_PARAMS: Partial<UsersListParams> = {
  page: 1,
  orgSearch: DEFAULT_USERS_PARAMS.orgSearch,
  tags: [],
  ...Object.fromEntries(USERS_FILTER_KEYS.map(key => [key, undefined])),
};

export const countActiveFilters = (params: UsersListView): number =>
  // The created-at window is one filter however many of its two ends are set.
  USERS_FILTER_KEYS.filter(key => params[key] !== undefined && !(key === 'createdTo' && params.createdFrom)).length +
  (params.orgSearch.length > 0 && !params.orgSearch.includes('all') ? 1 : 0) +
  (params.tags.length > 0 ? 1 : 0);

/** A stored copy from before the list rebuild may carry an old page size or the hour-only flag. */
export function migrateStoredUsersParams(stored: Record<string, unknown>): UsersListParams {
  const view = usersViewFromSearch({
    page: stored.page,
    limit: stored.limit,
    sort: stored.sortField,
    order: stored.sortOrder,
    org: stored.orgSearch,
    tags: stored.tags,
    groupBy: stored.groupBy,
    recentSignups: stored.recentSignups,
    ...Object.fromEntries(USERS_FILTER_KEYS.map(key => [USERS_FILTER_PARAMS[key], stored[key]])),
  });
  return {
    ...DEFAULT_USERS_PARAMS,
    ...view,
    search: typeof stored.search === 'string' ? stored.search.slice(0, 500) : '',
  };
}
