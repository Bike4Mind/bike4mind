import { describe, expect, it } from 'vitest';
import { DEFAULT_USERS_PARAMS, USERS_SEARCH_PARSERS, usersViewFromSearch, usersViewToSearch } from './usersTabSearch';

describe('USERS_SEARCH_PARSERS', () => {
  it('coerces valid values and drops invalid ones', () => {
    expect(USERS_SEARCH_PARSERS.page(3)).toBe(3);
    expect(USERS_SEARCH_PARSERS.page('3')).toBe(3);
    expect(USERS_SEARCH_PARSERS.page(0)).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.page(1.5)).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.page('abc')).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.limit(20)).toBe(20);
    expect(USERS_SEARCH_PARSERS.limit(500)).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.sort('name')).toBe('name');
    expect(USERS_SEARCH_PARSERS.sort('password')).toBeUndefined();

    expect(USERS_SEARCH_PARSERS.order('asc')).toBe('asc');
    expect(USERS_SEARCH_PARSERS.order('sideways')).toBeUndefined();
  });

  it('reads a list from an array or a lone string, dropping non-strings and blanks', () => {
    expect(USERS_SEARCH_PARSERS.tags(['Admin', '', 7, 'Beta'])).toEqual(['Admin', 'Beta']);
    expect(USERS_SEARCH_PARSERS.org('Acme')).toEqual(['Acme']);
    expect(USERS_SEARCH_PARSERS.org([])).toBeUndefined();
    expect(USERS_SEARCH_PARSERS.tags({ not: 'a list' })).toBeUndefined();
  });
});

describe('usersViewFromSearch', () => {
  it('is undefined when the URL carries no view param, so the stored view is restored', () => {
    expect(usersViewFromSearch({ tab: 'users', userId: 'u1' })).toBeUndefined();
  });

  it('treats invalid values as absent', () => {
    expect(usersViewFromSearch({ page: 'abc', order: 'sideways' })).toBeUndefined();
  });

  it('fills every missing view param with its default once any is present', () => {
    expect(usersViewFromSearch({ page: 3, tags: ['Admin'] })).toEqual({
      page: 3,
      limit: DEFAULT_USERS_PARAMS.limit,
      sortField: DEFAULT_USERS_PARAMS.sortField,
      sortOrder: DEFAULT_USERS_PARAMS.sortOrder,
      orgSearch: DEFAULT_USERS_PARAMS.orgSearch,
      tags: ['Admin'],
    });
  });
});

describe('usersViewToSearch', () => {
  it('writes only page for the default view', () => {
    expect(usersViewToSearch(DEFAULT_USERS_PARAMS)).toEqual({
      page: 1,
      limit: undefined,
      sort: undefined,
      order: undefined,
      org: undefined,
      tags: undefined,
    });
  });

  it('writes every non-default value and never the free-text search', () => {
    const search = usersViewToSearch({
      ...DEFAULT_USERS_PARAMS,
      page: 2,
      limit: 20,
      sortField: 'name',
      sortOrder: 'asc',
      orgSearch: ['Acme', 'Unassigned'],
      tags: ['Admin'],
      search: 'someone@example.com',
    });

    expect(search).toEqual({
      page: 2,
      limit: 20,
      sort: 'name',
      order: 'asc',
      org: ['Acme', 'Unassigned'],
      tags: ['Admin'],
    });
    expect(JSON.stringify(search)).not.toContain('example.com');
  });

  it('round-trips through usersViewFromSearch', () => {
    const params = { ...DEFAULT_USERS_PARAMS, page: 4, sortOrder: 'asc' as const, tags: ['Beta'] };
    expect(usersViewFromSearch(usersViewToSearch(params))).toEqual({
      page: 4,
      limit: params.limit,
      sortField: params.sortField,
      sortOrder: 'asc',
      orgSearch: params.orgSearch,
      tags: ['Beta'],
    });
  });
});
