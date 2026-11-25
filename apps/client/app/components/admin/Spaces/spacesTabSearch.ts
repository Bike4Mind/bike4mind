import { ADMIN_PAGE_SIZES } from '../shared/adminPagination';
import { oneOf, parseObjectId, parsePage, toNumber } from '../adminSearchValues';

// Kept React-free: router.tsx imports it eagerly through adminTabParams.ts. The free-text search is
// left out because these URLs get shared and the text may be an email.

export const ADMIN_SPACES_TAB_SLUG = 'spaces';

export const SPACES_PAGE_PARAM = 'spacesPage';
export const SPACES_LIMIT_PARAM = 'spacesLimit';
export const SPACES_SORT_PARAM = 'spacesSort';
export const SPACES_ID_PARAM = 'spaceId';

export const SPACES_TAB_PARAMS = [SPACES_PAGE_PARAM, SPACES_LIMIT_PARAM, SPACES_SORT_PARAM, SPACES_ID_PARAM] as const;

const SPACES_SORT_FIELDS = ['createdAt', 'name'] as const;

export type SpacesSortField = (typeof SPACES_SORT_FIELDS)[number];

export type SpacesView = { page: number; limit: number; sort: SpacesSortField };

export const DEFAULT_SPACES_VIEW: SpacesView = { page: 1, limit: ADMIN_PAGE_SIZES[0], sort: 'createdAt' };

export type SpacesSearch = {
  [SPACES_PAGE_PARAM]?: number;
  [SPACES_LIMIT_PARAM]?: number;
  [SPACES_SORT_PARAM]?: SpacesSortField;
  [SPACES_ID_PARAM]?: string;
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return ADMIN_PAGE_SIZES.some(size => size === limit) ? limit : undefined;
};

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const SPACES_SEARCH_PARSERS: { readonly [K in keyof SpacesSearch]-?: (value: unknown) => SpacesSearch[K] } = {
  [SPACES_PAGE_PARAM]: parsePage,
  [SPACES_LIMIT_PARAM]: parseLimit,
  [SPACES_SORT_PARAM]: oneOf(SPACES_SORT_FIELDS),
  [SPACES_ID_PARAM]: parseObjectId,
};

export const spacesViewFromSearch = (search: Record<string, unknown>): SpacesView => ({
  page: parsePage(search[SPACES_PAGE_PARAM]) ?? DEFAULT_SPACES_VIEW.page,
  limit: parseLimit(search[SPACES_LIMIT_PARAM]) ?? DEFAULT_SPACES_VIEW.limit,
  sort: oneOf(SPACES_SORT_FIELDS)(search[SPACES_SORT_PARAM]) ?? DEFAULT_SPACES_VIEW.sort,
});

/** Defaults are left out of the URL. */
export const spacesViewToSearch = (view: SpacesView): Omit<SpacesSearch, typeof SPACES_ID_PARAM> => ({
  [SPACES_PAGE_PARAM]: view.page === DEFAULT_SPACES_VIEW.page ? undefined : view.page,
  [SPACES_LIMIT_PARAM]: view.limit === DEFAULT_SPACES_VIEW.limit ? undefined : view.limit,
  [SPACES_SORT_PARAM]: view.sort === DEFAULT_SPACES_VIEW.sort ? undefined : view.sort,
});

/** The admin console URL that opens one Space's detail. */
export const adminSpaceHref = (spaceId: string): string =>
  `/admin?${new URLSearchParams({ tab: ADMIN_SPACES_TAB_SLUG, [SPACES_ID_PARAM]: spaceId })}`;
