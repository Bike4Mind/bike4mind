import { describe, expect, it } from 'vitest';
import { DEFAULT_USERS_PARAMS } from '../usersTabSearch';
import { USERS_BUILT_IN_VIEWS, activeUsersView, applyUsersView } from './usersListViews';
import { toAdminUsersFilter } from './useAdminUsersList';

const view = (id: string) => USERS_BUILT_IN_VIEWS.find(candidate => candidate.id === id)!;

describe('built-in views', () => {
  it('opens a view by clearing every other filter', () => {
    const params = { ...DEFAULT_USERS_PARAMS, status: 'active' as const, tags: ['Beta'], sortField: 'name' as const };
    const opened = { ...params, ...applyUsersView(view('highRisk')) };
    expect(opened).toMatchObject({ risk: 'high', status: undefined, tags: [], sortField: 'name', page: 1 });
    expect(activeUsersView(opened)).toBe('highRisk');
  });

  it('lights a tab only when the filters are exactly that view', () => {
    expect(activeUsersView(DEFAULT_USERS_PARAMS)).toBe('all');
    expect(activeUsersView({ ...DEFAULT_USERS_PARAMS, status: 'suspended' })).toBe('suspended');
    expect(activeUsersView({ ...DEFAULT_USERS_PARAMS, status: 'suspended', plan: 'PaidUser' })).toBeUndefined();
    expect(activeUsersView({ ...DEFAULT_USERS_PARAMS, orgSearch: ['Acme'] })).toBeUndefined();
  });
});

describe('toAdminUsersFilter', () => {
  it('sends only what narrows the list', () => {
    expect(toAdminUsersFilter(DEFAULT_USERS_PARAMS)).toEqual({});
    expect(
      toAdminUsersFilter({
        ...DEFAULT_USERS_PARAMS,
        search: '  bot ',
        orgSearch: ['Acme', 'Unassigned'],
        tags: ['Admin'],
        emailDomain: 'example.com',
      })
    ).toEqual({ search: 'bot', orgSearch: ['Acme', 'Unassigned'], tags: ['Admin'], emailDomain: 'example.com' });
  });
});
