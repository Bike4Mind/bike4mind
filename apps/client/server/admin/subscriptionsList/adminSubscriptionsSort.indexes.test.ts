import { describe, expect, it } from 'vitest';
import { ADMIN_SUBSCRIPTIONS_SORT_FIELDS } from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@server/models/Subscription';

// A sort can only walk an index whose key it prefixes, so the _id tiebreak in adminSubscriptionsSort
// needs compound indexes.
describe('admin subscriptions list sort indexes', () => {
  const keys = Subscription.schema.indexes().map(([key]) => Object.keys(key));

  it.each(ADMIN_SUBSCRIPTIONS_SORT_FIELDS)('%s has an index starting {field, _id}', field => {
    expect(keys.some(keyFields => keyFields[0] === field && keyFields[1] === '_id')).toBe(true);
  });

  it('indexes status then createdAt for the status-filtered list', () => {
    expect(keys.some(keyFields => keyFields.join() === 'status,createdAt,_id')).toBe(true);
  });
});
