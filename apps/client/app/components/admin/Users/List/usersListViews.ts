import type { AdminUsersSummary } from '@client/app/utils/adminUsersFilter';
import { matchSavedView, type SavedViewValues } from '../../shared/matchSavedView';
import {
  CLEARED_FILTER_PARAMS,
  DEFAULT_USERS_PARAMS,
  USERS_FILTER_KEYS,
  type UsersListParams,
  type UsersListView,
} from '../usersTabSearch';

export type UsersBuiltInView = {
  id: 'all' | 'new' | 'highRisk' | 'suspended';
  label: string;
  /** The filters the view applies on top of a cleared filter set. */
  filters: Partial<UsersListView>;
  count: (summary: AdminUsersSummary) => number;
};

export const USERS_BUILT_IN_VIEWS: readonly UsersBuiltInView[] = [
  { id: 'all', label: 'All', filters: {}, count: summary => summary.total },
  { id: 'new', label: 'New this week', filters: { signedUp: 'week' }, count: summary => summary.views.newThisWeek },
  { id: 'highRisk', label: 'High risk', filters: { risk: 'high' }, count: summary => summary.views.highRisk },
  { id: 'suspended', label: 'Suspended', filters: { status: 'suspended' }, count: summary => summary.views.suspended },
];

/** The patch that opens a view: every filter cleared, then the view's own. */
export const applyUsersView = (view: UsersBuiltInView): Partial<UsersListParams> => ({
  ...CLEARED_FILTER_PARAMS,
  ...view.filters,
});

const narrowsOrg = (orgSearch: readonly string[]) => orgSearch.length > 0 && !orgSearch.includes('all');

/**
 * What a list view's filters are compared on: the single-choice filters, the tags, and the org
 * list only when it narrows (an empty list and one holding 'all' both mean every org).
 */
export const usersFilterValues = (params: UsersListView): SavedViewValues => ({
  ...Object.fromEntries(USERS_FILTER_KEYS.map(key => [key, params[key]])),
  tags: params.tags,
  orgSearch: narrowsOrg(params.orgSearch) ? params.orgSearch : [],
});

/** The built-in view the current filters are exactly, if any. Sort, page size and grouping are not compared. */
export function activeUsersView(params: UsersListParams): UsersBuiltInView['id'] | undefined {
  return matchSavedView(USERS_BUILT_IN_VIEWS, usersFilterValues(params), view =>
    usersFilterValues({ ...DEFAULT_USERS_PARAMS, ...applyUsersView(view) })
  )?.id;
}
