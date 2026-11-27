import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import {
  SUBSCRIPTIONS_BUILT_IN_VIEWS,
  applySubscriptionsView,
  type SubscriptionsBuiltInView,
} from '../Subscriptions/subscriptionsListViews';
import {
  ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  DEFAULT_SUBSCRIPTIONS_PARAMS,
  subscriptionsViewToSearch,
  type SubscriptionsListView,
  type SubscriptionsSearch,
} from '../Subscriptions/subscriptionsTabSearch';

/** The URL carries the whole view, so the list never mixes in the admin's last filters. */
export function subscriptionsViewSearch(
  viewId: SubscriptionsBuiltInView['id'],
  filters: Partial<SubscriptionsListView> = {}
): SubscriptionsSearch & { [ADMIN_TAB_PARAM]: string } {
  const view = SUBSCRIPTIONS_BUILT_IN_VIEWS.find(candidate => candidate.id === viewId);
  const listView: SubscriptionsListView = {
    ...DEFAULT_SUBSCRIPTIONS_PARAMS,
    ...(view ? applySubscriptionsView(view) : {}),
    ...filters,
  };
  return { [ADMIN_TAB_PARAM]: ADMIN_SUBSCRIPTIONS_TAB_SLUG, ...subscriptionsViewToSearch(listView) };
}
