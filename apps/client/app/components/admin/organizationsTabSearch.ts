import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import { oneOf, parsePage, toNumber } from './adminSearchValues';

// Kept React-free: router.tsx imports it eagerly through adminTabParams.ts. The free-text search is
// left out because these URLs get shared and copied into login redirects; the `orgs` prefix is
// because Users already owns the bare `page`/`limit`/`sort`/`order`.

// Re-exported by adminTabParams.ts, which imports this file.
export const ADMIN_ORGANIZATIONS_TAB_SLUG = 'organizations';

export const ORGS_PAGE_PARAM = 'orgsPage';
export const ORGS_LIMIT_PARAM = 'orgsLimit';
export const ORGS_SORT_PARAM = 'orgsSort';
export const ORGS_ORDER_PARAM = 'orgsOrder';
export const ORGS_PERSONAL_PARAM = 'orgsPersonal';
export const ORGS_ORG_ID_PARAM = 'orgId';

/** The params that describe the list view; `orgId` (the open organization) is separate. */
const ORGS_VIEW_PARAMS = [
  ORGS_PAGE_PARAM,
  ORGS_LIMIT_PARAM,
  ORGS_SORT_PARAM,
  ORGS_ORDER_PARAM,
  ORGS_PERSONAL_PARAM,
] as const;

export const ORGS_TAB_PARAMS = [...ORGS_VIEW_PARAMS, ORGS_ORG_ID_PARAM] as const;

/** The admin console URL that opens one organization's profile. */
export const adminOrganizationHref = (orgId: string): string =>
  `/admin?${new URLSearchParams({ tab: ADMIN_ORGANIZATIONS_TAB_SLUG, [ORGS_ORG_ID_PARAM]: orgId })}`;

export const ORGS_PAGE_LIMIT_OPTIONS = [5, 10, 20];

const ORGS_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;
const SORT_ORDERS = ['asc', 'desc'] as const;

type OrgsSortField = (typeof ORGS_SORT_FIELDS)[number];
type SortOrder = (typeof SORT_ORDERS)[number];

/** The list params the tab queries with; `search` is held in the persisted store only. */
export type OrganizationsTabParams = {
  page: number;
  limit: number;
  search: string;
  /** undefined is "All types". */
  personal: boolean | undefined;
  sortBy: OrgsSortField;
  sortDirection: SortOrder;
};

export type OrganizationsView = Omit<OrganizationsTabParams, 'search'>;

export const DEFAULT_ORGANIZATIONS_PARAMS: OrganizationsTabParams = {
  page: 1,
  limit: 10,
  search: '',
  personal: undefined,
  sortBy: 'name',
  sortDirection: 'asc',
};

export type OrganizationsSearch = {
  [ORGS_PAGE_PARAM]?: number;
  [ORGS_LIMIT_PARAM]?: number;
  [ORGS_SORT_PARAM]?: OrgsSortField;
  [ORGS_ORDER_PARAM]?: SortOrder;
  [ORGS_PERSONAL_PARAM]?: boolean;
  [ORGS_ORG_ID_PARAM]?: string;
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return ORGS_PAGE_LIMIT_OPTIONS.includes(limit) ? limit : undefined;
};

// TanStack's JSON search parser hands `true` back as a boolean, but a hand-typed link may quote it.
const parsePersonal = (value: unknown): boolean | undefined => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
};

// The id is interpolated into `/api/organizations/<id>`, so only an ObjectId may come in from a link.
const parseOrgId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[0-9a-f]{24}$/i.test(value) ? value.toLowerCase() : undefined;

// A view param that fails to parse still asked for a view. Keeping the default page stops
// `validateSearch` from reducing `?orgsSort=credits` to a bare visit that restores the saved view.
// Other tabs get no fallback, so a stray invalid orgs param is dropped there rather than becoming a page.
const parseOrgsPage = (value: unknown, search: Record<string, unknown> = {}): number | undefined =>
  parsePage(value) ??
  (search[ADMIN_TAB_PARAM] === ADMIN_ORGANIZATIONS_TAB_SLUG && ORGS_VIEW_PARAMS.some(key => search[key] !== undefined)
    ? DEFAULT_ORGANIZATIONS_PARAMS.page
    : undefined);

/**
 * Per-key coercion for the route's `validateSearch`, given the whole raw search as well; anything
 * invalid becomes undefined.
 */
export const ORGS_SEARCH_PARSERS: {
  readonly [K in keyof OrganizationsSearch]-?: (
    value: unknown,
    search?: Record<string, unknown>
  ) => OrganizationsSearch[K];
} = {
  [ORGS_PAGE_PARAM]: parseOrgsPage,
  [ORGS_LIMIT_PARAM]: parseLimit,
  [ORGS_SORT_PARAM]: oneOf(ORGS_SORT_FIELDS),
  [ORGS_ORDER_PARAM]: oneOf(SORT_ORDERS),
  [ORGS_PERSONAL_PARAM]: parsePersonal,
  [ORGS_ORG_ID_PARAM]: parseOrgId,
};

/**
 * The list view a URL describes, or undefined for a bare `?tab=organizations` (restore the saved
 * view). Any view param means a whole view with defaults for the rest, so a shared link never picks
 * up the recipient's saved page, sort or type filter.
 */
export function organizationsViewFromSearch(search: Record<string, unknown>): OrganizationsView | undefined {
  const parsed = {
    page: parsePage(search[ORGS_PAGE_PARAM]),
    limit: parseLimit(search[ORGS_LIMIT_PARAM]),
    sortBy: ORGS_SEARCH_PARSERS[ORGS_SORT_PARAM](search[ORGS_SORT_PARAM]),
    sortDirection: ORGS_SEARCH_PARSERS[ORGS_ORDER_PARAM](search[ORGS_ORDER_PARAM]),
    personal: parsePersonal(search[ORGS_PERSONAL_PARAM]),
  };
  if (Object.values(parsed).every(value => value === undefined)) return undefined;
  return {
    page: parsed.page ?? DEFAULT_ORGANIZATIONS_PARAMS.page,
    limit: parsed.limit ?? DEFAULT_ORGANIZATIONS_PARAMS.limit,
    sortBy: parsed.sortBy ?? DEFAULT_ORGANIZATIONS_PARAMS.sortBy,
    sortDirection: parsed.sortDirection ?? DEFAULT_ORGANIZATIONS_PARAMS.sortDirection,
    personal: parsed.personal,
  };
}

/** Defaults are left out, except the page, so the URL always reads back as a whole view. */
export function organizationsViewToSearch(
  view: OrganizationsView
): Omit<OrganizationsSearch, typeof ORGS_ORG_ID_PARAM> {
  const unlessDefault = <T>(value: T, isDefault: boolean): T | undefined => (isDefault ? undefined : value);
  return {
    [ORGS_PAGE_PARAM]: parsePage(view.page) ?? DEFAULT_ORGANIZATIONS_PARAMS.page,
    [ORGS_LIMIT_PARAM]: unlessDefault(parseLimit(view.limit), view.limit === DEFAULT_ORGANIZATIONS_PARAMS.limit),
    [ORGS_SORT_PARAM]: unlessDefault(
      ORGS_SEARCH_PARSERS[ORGS_SORT_PARAM](view.sortBy),
      view.sortBy === DEFAULT_ORGANIZATIONS_PARAMS.sortBy
    ),
    [ORGS_ORDER_PARAM]: unlessDefault(
      ORGS_SEARCH_PARSERS[ORGS_ORDER_PARAM](view.sortDirection),
      view.sortDirection === DEFAULT_ORGANIZATIONS_PARAMS.sortDirection
    ),
    [ORGS_PERSONAL_PARAM]: parsePersonal(view.personal),
  };
}

/** Whether two param sets describe the same list view (the free-text search is not compared). */
export function isSameOrganizationsView(a: OrganizationsView, b: OrganizationsView): boolean {
  return (
    a.page === b.page &&
    a.limit === b.limit &&
    a.sortBy === b.sortBy &&
    a.sortDirection === b.sortDirection &&
    a.personal === b.personal
  );
}

/**
 * The last page to move to when `page` is past the end, or undefined to stay. Waits for the current
 * search to settle; zero pages (a failed search reports that too) is left alone.
 */
export function organizationsPageToClampTo({
  page,
  totalPages,
  isFetching,
}: {
  page: number;
  totalPages: number;
  isFetching: boolean;
}): number | undefined {
  return !isFetching && totalPages > 0 && page > totalPages ? totalPages : undefined;
}
