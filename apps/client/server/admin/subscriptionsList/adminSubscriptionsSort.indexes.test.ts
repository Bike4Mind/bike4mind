import { describe, expect, it } from 'vitest';
import { ADMIN_SUBSCRIPTIONS_SORT_FIELDS } from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { adminSubscriptionsSort } from './adminSubscriptionsQuery';

// A sort can only walk an index whose key it prefixes (in either direction), so the _id tiebreak in
// adminSubscriptionsSort needs compound indexes with matching directions.
describe('admin subscriptions list sort indexes', () => {
  const keys = Subscription.schema.indexes().map(([key]) => JSON.stringify(key));
  const reversed = (sort: Record<string, 1 | -1>) =>
    JSON.stringify(Object.fromEntries(Object.entries(sort).map(([field, direction]) => [field, -direction])));

  it.each(ADMIN_SUBSCRIPTIONS_SORT_FIELDS)('%s has an index matching its {field, _id} sort', field => {
    const sort = adminSubscriptionsSort(field, 'desc');
    expect(keys.some(key => key === JSON.stringify(sort) || key === reversed(sort))).toBe(true);
  });

  it('indexes status then createdAt for the status-filtered list', () => {
    expect(keys).toContain(JSON.stringify({ status: 1, createdAt: -1, _id: -1 }));
  });
});
