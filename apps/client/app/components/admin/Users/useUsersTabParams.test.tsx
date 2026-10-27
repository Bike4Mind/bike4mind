import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { DEFAULT_USERS_PARAMS, useUsersParams, useUsersTab, useUsersTabUrlSync } from './useUsersTabParams';

const STORED = {
  ...DEFAULT_USERS_PARAMS,
  page: 3,
  sortField: 'name' as const,
  sortOrder: 'asc' as const,
  tags: ['Admin'],
  search: 'someone@example.com',
};

/** The Users tab as mounted: the sync hook plus a consumer reading the params. */
const renderUsersTab = () =>
  renderHook(() => {
    useUsersTabUrlSync();
    return useUsersParams();
  });

beforeEach(() => {
  act(() => {
    useUsersTab.setState({ params: { ...STORED } });
    fakeAdminRouter.reset();
  });
});

describe('Users tab URL precedence', () => {
  it('reads an old last-hour link as Signed up and round-trips grouping through URL and persisted state', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 1, groupBy: 'emailDomain', recentSignups: 'hour' }));
    const { result } = renderUsersTab();
    expect(result.current[0]).toMatchObject({ groupBy: 'emailDomain', signedUp: 'hour' });
    expect(useUsersTab.getState().params).toMatchObject({ groupBy: 'emailDomain', signedUp: 'hour' });
    act(() => result.current[1]({ groupBy: undefined, signedUp: undefined }));
    expect(fakeAdminRouter.search).toEqual({ tab: 'users', page: 1 });
    expect(result.current[0].groupBy).toBeUndefined();
  });

  it('writes the stored view into a bare users URL, without the free-text search', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users' }));
    const { result } = renderUsersTab();

    expect(fakeAdminRouter.search).toEqual({ tab: 'users', page: 3, sort: 'name', order: 'asc', tags: ['Admin'] });
    expect(result.current[0]).toMatchObject({
      page: 3,
      sortField: 'name',
      tags: ['Admin'],
      search: 'someone@example.com',
    });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('lets a URL view win and copies it into the store for the next bare visit', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 2, org: ['Acme'] }));
    const { result } = renderUsersTab();

    const expectedView = {
      page: 2,
      limit: DEFAULT_USERS_PARAMS.limit,
      sortField: DEFAULT_USERS_PARAMS.sortField,
      sortOrder: DEFAULT_USERS_PARAMS.sortOrder,
      orgSearch: ['Acme'],
      tags: [],
    };
    // Missing view params are defaults, not the stored values: a shared link means what it says.
    expect(result.current[0]).toMatchObject(expectedView);
    expect(useUsersTab.getState().params).toMatchObject({ ...expectedView, search: STORED.search });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('reads a URL whose view params are all invalid as the default view, not the stored one', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', limit: 7, sort: 'bogus' }));
    const { result } = renderUsersTab();

    const defaultView = {
      page: 1,
      limit: DEFAULT_USERS_PARAMS.limit,
      sortField: DEFAULT_USERS_PARAMS.sortField,
      sortOrder: DEFAULT_USERS_PARAMS.sortOrder,
      orgSearch: DEFAULT_USERS_PARAMS.orgSearch,
      tags: [],
    };
    expect(result.current[0]).toMatchObject(defaultView);
    expect(useUsersTab.getState().params).toMatchObject({ ...defaultView, search: STORED.search });
    expect(fakeAdminRouter.search).toEqual({ tab: 'users', page: 1 });
  });

  it('leaves another tab URL alone', () => {
    act(() => fakeAdminRouter.reset({ tab: 'feedback' }));
    renderUsersTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('writes a filter change to both the URL and the store, keeping the open user', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 3, userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }));
    const { result } = renderUsersTab();

    act(() => result.current[1]({ tags: ['Beta'], page: 1 }));

    expect(fakeAdminRouter.search).toEqual({
      tab: 'users',
      page: 1,
      tags: ['Beta'],
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(useUsersTab.getState().params).toMatchObject({ page: 1, tags: ['Beta'] });
    expect(result.current[0]).toMatchObject({ page: 1, tags: ['Beta'] });
  });

  it('keeps a search-only change out of the URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 3 }));
    const { result } = renderUsersTab();

    act(() => result.current[1]({ search: 'other@example.com' }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(result.current[0].search).toBe('other@example.com');
  });

  it('composes two writes made in the same tick', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users', page: 3 }));
    const { result } = renderUsersTab();

    act(() => {
      result.current[1]({ sortOrder: 'asc', page: 1 });
      result.current[1]({ limit: 50, page: 1 });
    });

    expect(fakeAdminRouter.search).toEqual({ tab: 'users', page: 1, limit: 50, order: 'asc' });
  });
});
