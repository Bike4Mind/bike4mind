import type { AdminSavedViewResponse, UsersSavedView, UsersSavedViewParams } from '@client/app/utils/adminSavedViews';
import { matchSavedView, type SavedViewValues } from '../../shared/matchSavedView';
import {
  CLEARED_FILTER_PARAMS,
  DEFAULT_USERS_PARAMS,
  USERS_FILTER_KEYS,
  type UsersListParams,
} from '../usersTabSearch';
import { activeUsersView, usersFilterValues } from './usersListViews';

export type UsersSavedViewItem = AdminSavedViewResponse<'users'>;

/** The stored form of the current list: filters, search, sort, page size and grouping; never the page. */
export function toUsersSavedView(params: UsersListParams): UsersSavedView {
  const search = params.search.trim();
  const filters = Object.fromEntries(
    USERS_FILTER_KEYS.flatMap(key => (params[key] === undefined ? [] : [[key, params[key]]]))
  ) as Pick<UsersSavedViewParams, (typeof USERS_FILTER_KEYS)[number]>;
  return {
    version: 1,
    params: {
      ...filters,
      ...(search && { search }),
      orgSearch: [...params.orgSearch],
      tags: [...params.tags],
      sortField: params.sortField,
      sortOrder: params.sortOrder,
      limit: params.limit,
      ...(params.groupBy && { groupBy: params.groupBy }),
    },
  };
}

/**
 * The patch that opens a saved view on page 1. Every key the view can set is written, unset ones as
 * explicit undefined or their default, so nothing from the previous view leaks through.
 */
export function usersParamsFromSavedView({ params }: UsersSavedView): Partial<UsersListParams> {
  return {
    ...CLEARED_FILTER_PARAMS,
    ...Object.fromEntries(USERS_FILTER_KEYS.map(key => [key, params[key]])),
    page: 1,
    search: params.search ?? '',
    orgSearch: params.orgSearch ?? DEFAULT_USERS_PARAMS.orgSearch,
    tags: params.tags ?? [],
    sortField: params.sortField,
    sortOrder: params.sortOrder,
    limit: params.limit,
    groupBy: params.groupBy,
  };
}

/** A saved view compares on everything it stores, unlike a built-in, which keeps the sort. */
const savedViewValues = (params: UsersListParams): SavedViewValues => ({
  ...usersFilterValues(params),
  search: params.search.trim(),
  sortField: params.sortField,
  sortOrder: params.sortOrder,
  limit: params.limit,
  groupBy: params.groupBy,
});

export const savedViewParams = (view: UsersSavedViewItem): UsersListParams => ({
  ...DEFAULT_USERS_PARAMS,
  ...usersParamsFromSavedView(view.view),
});

/**
 * The tab to light: a saved view the list is exactly, else the built-in whose filters it is. The
 * saved view goes first because it matches on more (sort, page size, grouping, search), so it is the
 * more specific answer, and a view saved over an unfiltered list would otherwise never light up.
 */
export function activeUsersTabId(
  params: UsersListParams,
  savedViews: readonly UsersSavedViewItem[]
): string | undefined {
  return (
    matchSavedView(savedViews, savedViewValues(params), view => savedViewValues(savedViewParams(view)))?.id ??
    activeUsersView(params)
  );
}
