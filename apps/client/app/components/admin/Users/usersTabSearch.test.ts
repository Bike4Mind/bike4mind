import { describe, expect, it } from 'vitest';
import {
  CLEARED_FILTER_PARAMS,
  DEFAULT_USERS_PARAMS,
  USERS_SEARCH_PARSERS,
  countActiveFilters,
  isSameUsersView,
  migrateStoredUsersParams,
  usersViewFromSearch,
  usersViewToSearch,
} from './usersTabSearch';

const UNSET_FILTERS = {
  status: undefined,
  plan: undefined,
  emailDomain: undefined,
  signupMethod: undefined,
  verified: undefined,
  hasApiKey: undefined,
  signedUp: undefined,
  risk: undefined,
};
const DEFAULT_VIEW = {
  page: 1,
  limit: 25,
  sortField: 'createdAt',
  sortOrder: 'desc',
  orgSearch: ['all'],
  tags: [],
  groupBy: undefined,
  ...UNSET_FILTERS,
};
const UNWRITTEN = {
  limit: undefined,
  sort: undefined,
  order: undefined,
  org: undefined,
  tags: undefined,
  groupBy: undefined,
  recentSignups: undefined,
  domain: undefined,
  method: undefined,
  keys: undefined,
  status: undefined,
  plan: undefined,
  verified: undefined,
  signedUp: undefined,
  risk: undefined,
};

describe('USERS_SEARCH_PARSERS', () => {
  it('coerces valid values and drops invalid ones', () => {
    expect(USERS_SEARCH_PARSERS.page('3')).toBe(3);
    expect(USERS_SEARCH_PARSERS.page(0)).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.page(1e21)).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.limit(50)).toBe(50);
    expect(USERS_SEARCH_PARSERS.limit(10)).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.sort('lastActiveAt')).toBe('lastActiveAt');
    expect(USERS_SEARCH_PARSERS.sort('password')).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.status('suspended')).toBe('suspended');
    expect(USERS_SEARCH_PARSERS.status('deleted')).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.domain(' Example.COM ')).toBe('example.com');
    expect(USERS_SEARCH_PARSERS.domain('a b')).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.keys('yes')).toBe('yes');
    expect(USERS_SEARCH_PARSERS.risk('extreme')).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.userId('0123456789abcdef01234567')).toBe('0123456789abcdef01234567');
    expect(USERS_SEARCH_PARSERS.userId('../organizations')).toBeUndefined();
  });

  it('reads a list from an array or a lone string, dropping non-strings and blanks', () => {
    expect(USERS_SEARCH_PARSERS.tags(['Admin', '', 7, 'Beta'])).toEqual(['Admin', 'Beta']);
    expect(USERS_SEARCH_PARSERS.org('Acme')).toEqual(['Acme']);
    expect(USERS_SEARCH_PARSERS.tags({ not: 'a list' })).toBeUndefined();
  });
});

describe('usersViewFromSearch', () => {
  it('is undefined when the URL carries no view param, so the stored view is restored', () => {
    expect(usersViewFromSearch({ tab: 'users', userId: 'u1' })).toBeUndefined();
    expect(usersViewFromSearch({ page: 'abc', order: 'sideways' })).toBeUndefined();
  });

  it('fills every missing view param with its default, unset filters included', () => {
    expect(usersViewFromSearch({ page: 3, tags: ['Admin'], status: 'restricted', domain: 'example.com' })).toEqual({
      ...DEFAULT_VIEW,
      page: 3,
      tags: ['Admin'],
      status: 'restricted',
      emailDomain: 'example.com',
    });
  });

  it('opens an old last-hour link as the Signed up filter', () => {
    expect(usersViewFromSearch({ recentSignups: 'hour', groupBy: 'emailDomain' })).toMatchObject({
      signedUp: 'hour',
      groupBy: 'emailDomain',
    });
  });
});

describe('usersViewToSearch', () => {
  it('writes only page for the default view', () => {
    expect(usersViewToSearch(DEFAULT_USERS_PARAMS)).toEqual({ ...UNWRITTEN, page: 1 });
  });

  it('writes every non-default value and never the free-text search', () => {
    const search = usersViewToSearch({
      ...DEFAULT_USERS_PARAMS,
      page: 2,
      limit: 100,
      sortField: 'currentCredits',
      sortOrder: 'asc',
      orgSearch: ['Acme', 'Unassigned'],
      tags: ['Admin'],
      status: 'suspended',
      emailDomain: 'example.com',
      signupMethod: 'github',
      hasApiKey: 'no',
      signedUp: 'week',
      search: 'someone@example.org',
    });
    expect(search).toEqual({
      ...UNWRITTEN,
      page: 2,
      limit: 100,
      sort: 'currentCredits',
      order: 'asc',
      org: ['Acme', 'Unassigned'],
      tags: ['Admin'],
      status: 'suspended',
      domain: 'example.com',
      method: 'github',
      keys: 'no',
      signedUp: 'week',
    });
    expect(JSON.stringify(search)).not.toContain('someone');
  });

  it('round-trips through usersViewFromSearch', () => {
    const params = { ...DEFAULT_USERS_PARAMS, page: 4, sortOrder: 'asc' as const, risk: 'high' as const };
    const view = usersViewFromSearch(usersViewToSearch(params));
    expect(view && isSameUsersView(view, params)).toBe(true);
  });
});

describe('filters', () => {
  it('counts and clears every filter but keeps sort and grouping', () => {
    const params = {
      ...DEFAULT_USERS_PARAMS,
      sortField: 'name' as const,
      groupBy: 'emailDomain' as const,
      status: 'active' as const,
      tags: ['Beta'],
      orgSearch: ['Acme'],
    };
    expect(countActiveFilters(params)).toBe(3);
    const cleared = { ...params, ...CLEARED_FILTER_PARAMS };
    expect(countActiveFilters(cleared)).toBe(0);
    expect(cleared).toMatchObject({ sortField: 'name', groupBy: 'emailDomain', page: 1 });
  });
});

describe('migrateStoredUsersParams', () => {
  it('carries an old stored view onto the new page sizes and Signed up filter', () => {
    expect(
      migrateStoredUsersParams({
        page: 3,
        limit: 10,
        sortField: 'name',
        orgSearch: ['Acme'],
        recentSignups: 'hour',
        search: 'bots',
      })
    ).toMatchObject({ page: 3, limit: 25, sortField: 'name', orgSearch: ['Acme'], signedUp: 'hour', search: 'bots' });
    expect(migrateStoredUsersParams({})).toEqual(DEFAULT_USERS_PARAMS);
  });
});

describe('created-at window params', () => {
  it('accepts only ISO instants and normalizes them', () => {
    expect(USERS_SEARCH_PARSERS.createdFrom('2026-01-01T09:00:00+09:00')).toBe('2026-01-01T00:00:00.000Z');
    expect(USERS_SEARCH_PARSERS.createdFrom('2026-01-01')).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.createdTo('yesterday')).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.createdTo(42)).toBeUndefined();
  });

  it('round-trips through the URL as part of the view', () => {
    const view = usersViewFromSearch({
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-01T01:00:00.000Z',
    });
    expect(view).toMatchObject({
      page: 1,
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-01T01:00:00.000Z',
    });
    expect(usersViewToSearch({ ...DEFAULT_USERS_PARAMS, ...view })).toMatchObject({
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-01T01:00:00.000Z',
    });
  });
});
