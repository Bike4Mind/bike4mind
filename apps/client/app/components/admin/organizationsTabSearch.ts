import { oneOf, parsePage, toNumber } from './adminSearchValues';

/**
 * The Organizations tab's `/admin` search params and their coercion. Pure and React-free:
 * adminTabParams.ts (and through it router.tsx's eager import) reads it. The free-text search box is
 * deliberately absent - it matches organization names, and these URLs get shared and copied into
 * login redirects. The list params carry an `orgs` prefix because Users already owns the bare
 * `page`/`limit`/`sort`/`order`.
 */

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
  typeof value === 'string' && /^[0-9a-f]{24}$/.test(value) ? value : undefined;

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const ORGS_SEARCH_PARSERS: {
  readonly [K in keyof OrganizationsSearch]-?: (value: unknown) => OrganizationsSearch[K];
} = {
  [ORGS_PAGE_PARAM]: parsePage,
  [ORGS_LIMIT_PARAM]: parseLimit,
  [ORGS_SORT_PARAM]: oneOf(ORGS_SORT_FIELDS),
  [ORGS_ORDER_PARAM]: oneOf(SORT_ORDERS),
  [ORGS_PERSONAL_PARAM]: parsePersonal,
  [ORGS_ORG_ID_PARAM]: parseOrgId,
};

/**
 * The list view a URL describes, or undefined when it carries none of the view params (a bare
 * `?tab=organizations`, which restores the last view from localStorage). When any view param is
 * present the URL describes the whole view and a missing one means its default, so a shared link
 * never picks up the recipient's saved filters.
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

/**
 * The view params to write for `view`. Defaults are left out to keep links short, except the page,
 * which is always written so every Organizations URL carries a view param and reads back as a whole
 * view (see organizationsViewFromSearch) rather than as "restore from localStorage".
 */
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
