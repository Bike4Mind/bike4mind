import { describe, expect, it } from 'vitest';
import { UsersSavedViewSchema } from '@client/app/utils/adminSavedViews';
import { DEFAULT_USERS_PARAMS, usersViewToSearch, type UsersListParams } from '../usersTabSearch';
import {
  activeUsersTabId,
  toUsersSavedView,
  usersParamsFromSavedView,
  type UsersSavedViewItem,
} from './usersSavedViews';

const FILTERED: UsersListParams = {
  ...DEFAULT_USERS_PARAMS,
  page: 3,
  limit: 50,
  search: '  bot ',
  sortField: 'name',
  sortOrder: 'asc',
  status: 'active',
  emailDomain: 'example.com',
  tags: ['Beta'],
  orgSearch: ['Acme'],
  groupBy: 'emailDomain',
};

const item = (
  id: string,
  params: UsersListParams,
  overrides: Partial<UsersSavedViewItem> = {}
): UsersSavedViewItem => ({
  id,
  surface: 'users',
  name: id,
  shared: false,
  ownerId: 'a'.repeat(24),
  isOwner: true,
  view: toUsersSavedView(params),
  ...overrides,
});

describe('toUsersSavedView', () => {
  it('stores filters, trimmed search, sort, page size and grouping, never the page', () => {
    const view = toUsersSavedView(FILTERED);
    expect(view).toEqual({
      version: 1,
      params: {
        search: 'bot',
        status: 'active',
        emailDomain: 'example.com',
        tags: ['Beta'],
        orgSearch: ['Acme'],
        sortField: 'name',
        sortOrder: 'asc',
        limit: 50,
        groupBy: 'emailDomain',
      },
    });
    expect(UsersSavedViewSchema.parse(view)).toEqual(view);
    expect(toUsersSavedView(DEFAULT_USERS_PARAMS).params).not.toHaveProperty('search');
  });

  it('round-trips to the same list view on page 1, clearing whatever was set before', () => {
    const before: UsersListParams = { ...DEFAULT_USERS_PARAMS, risk: 'high', plan: 'PaidUser', page: 9 };
    const reopened = { ...before, ...usersParamsFromSavedView(toUsersSavedView(FILTERED)) };
    expect(reopened).toEqual({ ...FILTERED, search: 'bot', page: 1, risk: undefined, plan: undefined });
    expect(usersViewToSearch(reopened)).toEqual(usersViewToSearch({ ...FILTERED, page: 1 }));
  });
});

describe('activeUsersTabId', () => {
  it('lights a saved view only when everything it stores matches', () => {
    const views = [item('v1', FILTERED)];
    expect(activeUsersTabId({ ...FILTERED, page: 4 }, views)).toBe('v1');
    expect(activeUsersTabId({ ...FILTERED, sortOrder: 'desc' }, views)).toBeUndefined();
    expect(activeUsersTabId({ ...FILTERED, search: 'other' }, views)).toBeUndefined();
  });

  it('prefers an exact saved view over a built-in, else falls back to the built-in', () => {
    const byName: UsersListParams = { ...DEFAULT_USERS_PARAMS, sortField: 'name' };
    expect(activeUsersTabId(byName, [])).toBe('all');
    expect(activeUsersTabId(byName, [item('v2', byName)])).toBe('v2');
    expect(activeUsersTabId({ ...DEFAULT_USERS_PARAMS, status: 'suspended' }, [item('v2', byName)])).toBe('suspended');
  });
});
