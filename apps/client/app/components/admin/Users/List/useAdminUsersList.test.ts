import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { adminUsersQueryKey } from './useAdminUsersList';

describe('adminUsersQueryKey', () => {
  it("is refreshed by the existing ['users'] invalidations", async () => {
    const client = new QueryClient();
    const listKey = [...adminUsersQueryKey, 'page', { page: 1 }];
    client.setQueryData(listKey, { users: [] });

    await client.invalidateQueries({ queryKey: ['users'] });

    expect(client.getQueryState(listKey)?.isInvalidated).toBe(true);
  });
});
