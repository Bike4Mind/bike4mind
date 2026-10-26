import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ORGANIZATIONS_PARAMS,
  ORGS_SEARCH_PARSERS,
  organizationsPageToClampTo,
  organizationsViewFromSearch,
  organizationsViewToSearch,
} from './organizationsTabSearch';

const ORG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('ORGS_SEARCH_PARSERS', () => {
  it('accepts numbers quoted by a hand-typed link', () => {
    expect(ORGS_SEARCH_PARSERS.orgsPage('3')).toBe(3);
    expect(ORGS_SEARCH_PARSERS.orgsLimit('20')).toBe(20);
  });

  it('rejects a page size outside the menu and a non-positive page', () => {
    expect(ORGS_SEARCH_PARSERS.orgsLimit(7)).toBeUndefined();
    expect(ORGS_SEARCH_PARSERS.orgsPage(0)).toBeUndefined();
  });

  it('accepts the type filter as a boolean or its string form', () => {
    expect(ORGS_SEARCH_PARSERS.orgsPersonal(true)).toBe(true);
    expect(ORGS_SEARCH_PARSERS.orgsPersonal('false')).toBe(false);
    expect(ORGS_SEARCH_PARSERS.orgsPersonal('yes')).toBeUndefined();
  });

  it('only lets an ObjectId through as the open organization', () => {
    expect(ORGS_SEARCH_PARSERS.orgId(ORG_ID)).toBe(ORG_ID);
    expect(ORGS_SEARCH_PARSERS.orgId('../users')).toBeUndefined();
  });

  it('accepts a hand-pasted uppercase ObjectId as the lowercase id', () => {
    expect(ORGS_SEARCH_PARSERS.orgId(ORG_ID.toUpperCase())).toBe(ORG_ID);
  });
});

describe('organizationsViewFromSearch', () => {
  it('describes no view when the URL carries no view param', () => {
    expect(organizationsViewFromSearch({ tab: 'organizations', orgId: ORG_ID })).toBeUndefined();
  });

  it('fills missing params with defaults rather than leaving them open', () => {
    expect(organizationsViewFromSearch({ orgsSort: 'createdAt', orgsPersonal: false })).toEqual({
      page: 1,
      limit: DEFAULT_ORGANIZATIONS_PARAMS.limit,
      sortBy: 'createdAt',
      sortDirection: 'asc',
      personal: false,
    });
  });

  it('describes no view when every view param is invalid', () => {
    expect(organizationsViewFromSearch({ orgsPage: 'abc', orgsOrder: 'sideways' })).toBeUndefined();
  });
});

describe('organizationsViewToSearch', () => {
  it('leaves defaults out except the page', () => {
    expect(organizationsViewToSearch(DEFAULT_ORGANIZATIONS_PARAMS)).toEqual({
      orgsPage: 1,
      orgsLimit: undefined,
      orgsSort: undefined,
      orgsOrder: undefined,
      orgsPersonal: undefined,
    });
  });

  it('round-trips a non-default view', () => {
    const view = { page: 4, limit: 20, sortBy: 'updatedAt', sortDirection: 'desc', personal: true } as const;
    expect(organizationsViewFromSearch(organizationsViewToSearch(view))).toEqual(view);
  });
});

describe('organizationsPageToClampTo', () => {
  it('moves a page past the end to the last page once the search has settled', () => {
    expect(organizationsPageToClampTo({ page: 9, totalPages: 3, isFetching: false })).toBe(3);
  });

  it('waits while the search is fetching', () => {
    expect(organizationsPageToClampTo({ page: 9, totalPages: 3, isFetching: true })).toBeUndefined();
  });

  it('leaves the page alone when there are no pages', () => {
    expect(organizationsPageToClampTo({ page: 4, totalPages: 0, isFetching: false })).toBeUndefined();
  });

  it('leaves an in-range page alone', () => {
    expect(organizationsPageToClampTo({ page: 3, totalPages: 3, isFetching: false })).toBeUndefined();
  });
});
