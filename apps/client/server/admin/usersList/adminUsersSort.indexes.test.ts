import { describe, expect, it } from 'vitest';
import { User } from '@bike4mind/database';
import { adminUsersSort } from './adminUsersQuery';

// A sort can only walk an index whose key it prefixes, so the _id tiebreak in adminUsersSort
// needs compound indexes. `name` is deliberately unindexed.
describe('admin users list sort indexes', () => {
  const keys = User.schema.indexes().map(([key]) => JSON.stringify(key));

  it.each(['createdAt', 'lastActiveAt', 'currentCredits'] as const)('%s desc matches a User index key', field => {
    expect(keys).toContain(JSON.stringify(adminUsersSort(field, 'desc')));
  });
});
