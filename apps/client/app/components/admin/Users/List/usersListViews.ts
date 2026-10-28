import type { AdminUsersSummary } from '@client/app/utils/adminUsersFilter';
import { CLEARED_FILTER_PARAMS, USERS_FILTER_KEYS, type UsersListParams, type UsersListView } from '../usersTabSearch';

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

/**
 * The view the current filters are exactly, if any. A view is its filters, not a stored id, so a
 * shared link or a hand-set filter that matches a view lights its tab up too.
 */
export function activeUsersView(params: UsersListParams): UsersBuiltInView['id'] | undefined {
  const narrowsOrgOrTags = params.tags.length > 0 || (params.orgSearch.length > 0 && !params.orgSearch.includes('all'));
  if (narrowsOrgOrTags) return undefined;
  return USERS_BUILT_IN_VIEWS.find(view =>
    USERS_FILTER_KEYS.every(key => params[key] === (view.filters as Partial<UsersListView>)[key])
  )?.id;
}
