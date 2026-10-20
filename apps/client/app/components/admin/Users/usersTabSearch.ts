import type { IGetUsersParams } from '@client/app/utils/userAPICalls';
import { optionalStringSearchValue } from '@client/app/utils/optionalStringSearchValue';

/**
 * The Users tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it. The free-text `search` box is deliberately
 * absent - it usually holds an email, and these URLs get shared and copied into login redirects.
 */

export const PAGE_LIMIT_OPTIONS = [5, 10, 20];

// Must stay in sync with the options SortControls.tsx renders.
export const USERS_SORT_FIELDS = ['createdAt', 'name'] as const;

const SORT_ORDERS = ['asc', 'desc'] as const;

export const DEFAULT_USERS_PARAMS: IGetUsersParams = {
  page: 1,
  limit: 10,
  search: '',
  sortField: 'createdAt',
  sortOrder: 'desc',
  orgSearch: ['all'],
  tags: [],
};

export const USERS_PAGE_PARAM = 'page';
export const USERS_LIMIT_PARAM = 'limit';
export const USERS_SORT_PARAM = 'sort';
export const USERS_ORDER_PARAM = 'order';
export const USERS_ORG_PARAM = 'org';
export const USERS_TAGS_PARAM = 'tags';
export const USERS_USER_ID_PARAM = 'userId';

/** The params that describe the list view; `userId` (the open user) is separate. */
const USERS_VIEW_PARAMS = [
  USERS_PAGE_PARAM,
  USERS_LIMIT_PARAM,
  USERS_SORT_PARAM,
  USERS_ORDER_PARAM,
  USERS_ORG_PARAM,
  USERS_TAGS_PARAM,
] as const;

export const USERS_TAB_PARAMS = [...USERS_VIEW_PARAMS, USERS_USER_ID_PARAM] as const;

export type UsersSearch = {
  [USERS_PAGE_PARAM]?: number;
  [USERS_LIMIT_PARAM]?: number;
  [USERS_SORT_PARAM]?: (typeof USERS_SORT_FIELDS)[number];
  [USERS_ORDER_PARAM]?: (typeof SORT_ORDERS)[number];
  [USERS_ORG_PARAM]?: string[];
  [USERS_TAGS_PARAM]?: string[];
  [USERS_USER_ID_PARAM]?: string;
};

type UsersView = Pick<IGetUsersParams, 'page' | 'limit' | 'sortField' | 'sortOrder' | 'orgSearch' | 'tags'>;

// TanStack's JSON search parser hands numbers back as numbers, but a hand-typed link may quote them.
const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
};

const oneOf =
  <T extends string>(allowed: readonly T[]) =>
  (value: unknown): T | undefined =>
    allowed.find(option => option === value);

const parsePage = (value: unknown): number | undefined => {
  const page = toNumber(value);
  return Number.isInteger(page) && page >= 1 ? page : undefined;
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return PAGE_LIMIT_OPTIONS.includes(limit) ? limit : undefined;
};

// A lone string is accepted as a one-item list, so `?tags=Admin` works as well as `?tags=["Admin"]`.
const parseStringList = (value: unknown): string[] | undefined => {
  const items = Array.isArray(value) ? value : [value];
  const strings = items.filter((item): item is string => typeof item === 'string' && item !== '');
  return strings.length > 0 ? strings : undefined;
};

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const USERS_SEARCH_PARSERS: { readonly [K in keyof UsersSearch]-?: (value: unknown) => UsersSearch[K] } = {
  [USERS_PAGE_PARAM]: parsePage,
  [USERS_LIMIT_PARAM]: parseLimit,
  [USERS_SORT_PARAM]: oneOf(USERS_SORT_FIELDS),
  [USERS_ORDER_PARAM]: oneOf(SORT_ORDERS),
  [USERS_ORG_PARAM]: parseStringList,
  [USERS_TAGS_PARAM]: parseStringList,
  [USERS_USER_ID_PARAM]: optionalStringSearchValue,
};

/**
 * The list view a URL describes, or undefined when it carries none of the view params (a bare
 * `?tab=users`, which restores the last view from localStorage). When any view param is present the
 * URL describes the whole view and a missing one means its default, so a shared link never picks up
 * the recipient's saved filters.
 */
export function usersViewFromSearch(search: Record<string, unknown>): UsersView | undefined {
  const parsed = {
    page: parsePage(search[USERS_PAGE_PARAM]),
    limit: parseLimit(search[USERS_LIMIT_PARAM]),
    sortField: USERS_SEARCH_PARSERS[USERS_SORT_PARAM](search[USERS_SORT_PARAM]),
    sortOrder: USERS_SEARCH_PARSERS[USERS_ORDER_PARAM](search[USERS_ORDER_PARAM]),
    orgSearch: parseStringList(search[USERS_ORG_PARAM]),
    tags: parseStringList(search[USERS_TAGS_PARAM]),
  };
  if (Object.values(parsed).every(value => value === undefined)) return undefined;
  return {
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
export function usersViewToSearch(params: IGetUsersParams): Omit<UsersSearch, typeof USERS_USER_ID_PARAM> {
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
  };
}

/** Whether two param sets describe the same list view (the free-text search is not compared). */
export function isSameUsersView(a: IGetUsersParams, b: IGetUsersParams): boolean {
  return (
    a.page === b.page &&
    a.limit === b.limit &&
    a.sortField === b.sortField &&
    a.sortOrder === b.sortOrder &&
    sameList(a.orgSearch, b.orgSearch) &&
    sameList(a.tags, b.tags)
  );
}
