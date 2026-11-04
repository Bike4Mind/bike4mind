import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import { DEFAULT_SUBSCRIPTIONS_PARAMS } from './subscriptionsTabSearch';
import { useSubscriptionsParams, useSubscriptionsTab, useSubscriptionsTabUrlSync } from './useSubscriptionsTabParams';

const STORED = {
  ...DEFAULT_SUBSCRIPTIONS_PARAMS,
  page: 3,
  limit: 50,
  sortField: 'periodEndsAt' as const,
  search: 'someone@example.com',
};

/** The Subscriptions tab as mounted: the sync hook plus a consumer reading the params. */
const renderSubscriptionsTab = () =>
  renderHook(() => {
    useSubscriptionsTabUrlSync();
    return useSubscriptionsParams();
  });

beforeEach(() => {
  act(() => {
    useSubscriptionsTab.setState({ params: { ...STORED } });
    fakeAdminRouter.reset();
  });
});

describe('Subscriptions tab URL precedence', () => {
  it('writes the stored view into a bare subscriptions URL, without the free-text search', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions' }));
    const { result } = renderSubscriptionsTab();

    expect(fakeAdminRouter.search).toMatchObject({
      tab: 'subscriptions',
      subsPage: 3,
      subsLimit: 50,
      subsSort: 'periodEndsAt',
    });
    expect(JSON.stringify(fakeAdminRouter.search)).not.toContain('someone@example.com');
    expect(result.current[0]).toMatchObject({ page: 3, limit: 50, search: 'someone@example.com' });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('lets a URL view win and copies it into the store for the next bare visit', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsPage: 2 }));
    const { result } = renderSubscriptionsTab();

    expect(result.current[0]).toMatchObject({ page: 2, limit: DEFAULT_SUBSCRIPTIONS_PARAMS.limit });
    expect(useSubscriptionsTab.getState().params).toMatchObject({ page: 2, search: STORED.search });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('reads a URL whose view params are all invalid as the default view, not the stored one', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsSort: 'bogus', subsLimit: 7 }));
    const { result } = renderSubscriptionsTab();

    const defaultView = {
      page: 1,
      limit: DEFAULT_SUBSCRIPTIONS_PARAMS.limit,
      sortField: DEFAULT_SUBSCRIPTIONS_PARAMS.sortField,
      sortOrder: DEFAULT_SUBSCRIPTIONS_PARAMS.sortOrder,
    };
    expect(result.current[0]).toMatchObject(defaultView);
    expect(useSubscriptionsTab.getState().params).toMatchObject({ ...defaultView, search: STORED.search });
    expect(fakeAdminRouter.search).toEqual({ tab: 'subscriptions', subsPage: 1 });
  });

  it('leaves another tab URL alone', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users' }));
    renderSubscriptionsTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('keeps a search-only change out of the URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsPage: 3 }));
    const { result } = renderSubscriptionsTab();
    fakeAdminRouter.navigate.mockClear();

    act(() => result.current[1]({ search: 'other@example.com' }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(result.current[0].search).toBe('other@example.com');
  });

  it('keeps a late search callback from writing onto another tab', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsPage: 3 }));
    const { result } = renderSubscriptionsTab();

    act(() => fakeAdminRouter.reset({ tab: 'users' }));
    act(() => result.current[1]({ search: 'other@example.com', page: 1 }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(fakeAdminRouter.search).toEqual({ tab: 'users' });
    expect(useSubscriptionsTab.getState().params.search).toBe('other@example.com');
  });

  it('keeps a late search callback from navigating back to admin', () => {
    act(() => fakeAdminRouter.reset({ tab: 'subscriptions', subsPage: 3 }));
    const { result } = renderSubscriptionsTab();

    act(() => fakeAdminRouter.reset({}, '/chat'));
    act(() => result.current[1]({ search: 'other@example.com', page: 1 }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(fakeAdminRouter.search).toEqual({});
  });
});
