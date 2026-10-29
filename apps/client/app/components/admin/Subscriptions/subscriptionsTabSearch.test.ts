import { describe, expect, it } from 'vitest';
import { parseAdminSearch } from '../adminTabParams';
import {
  SUBSCRIPTIONS_BUILT_IN_VIEWS,
  activeSubscriptionsView,
  applySubscriptionsView,
} from './subscriptionsListViews';
import {
  DEFAULT_SUBSCRIPTIONS_PARAMS,
  isSameSubscriptionsView,
  subscriptionsViewFromSearch,
  subscriptionsViewToSearch,
  type SubscriptionsListView,
} from './subscriptionsTabSearch';

const roundTrip = (view: SubscriptionsListView) =>
  subscriptionsViewFromSearch(parseAdminSearch({ tab: 'subscriptions', ...subscriptionsViewToSearch(view) }));

describe('subscriptions tab search', () => {
  it('round-trips every built-in view through the URL', () => {
    for (const builtIn of SUBSCRIPTIONS_BUILT_IN_VIEWS) {
      const view = { ...DEFAULT_SUBSCRIPTIONS_PARAMS, ...applySubscriptionsView(builtIn) };
      const restored = roundTrip(view);
      expect(restored && isSameSubscriptionsView(restored, view)).toBe(true);
      expect(restored && activeSubscriptionsView(restored)?.id).toBe(builtIn.id);
    }
  });

  it('keeps short links: default page size and sort are left out, the page is always written', () => {
    expect(subscriptionsViewToSearch(DEFAULT_SUBSCRIPTIONS_PARAMS)).toMatchObject({
      subsPage: 1,
      subsLimit: undefined,
      subsSort: undefined,
      subsOrder: undefined,
      subsStatus: ['active', 'past_due'],
      subsSource: 'stripe',
    });
    const view = {
      ...DEFAULT_SUBSCRIPTIONS_PARAMS,
      limit: 100,
      sortField: 'periodEndsAt' as const,
      sortOrder: 'asc' as const,
    };
    const restored = roundTrip(view);
    expect(restored && isSameSubscriptionsView(restored, view)).toBe(true);
  });

  it('treats a bare tab link as no view, and any view param as the whole view', () => {
    expect(subscriptionsViewFromSearch({ tab: 'subscriptions' })).toBeUndefined();
    expect(subscriptionsViewFromSearch({ subsCancel: 'scheduled' })).toMatchObject({
      cancel: 'scheduled',
      status: undefined,
      source: undefined,
      page: 1,
      limit: 25,
    });
  });

  it('drops unknown values and orders statuses canonically', () => {
    const parsed = parseAdminSearch({
      tab: 'subscriptions',
      subsStatus: ['past_due', 'bogus', 'active', 'active'],
      subsSource: 'paypal',
      subsCancel: 'soon',
      subsLimit: 7,
    });
    expect(subscriptionsViewFromSearch(parsed)).toMatchObject({
      status: ['active', 'past_due'],
      source: undefined,
      cancel: undefined,
      limit: 25,
    });
  });
});
