import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { DEFAULT_ORGANIZATIONS_PARAMS } from './organizationsTabSearch';
import {
  useOpenOrganizationId,
  useOrganizationsParams,
  useOrganizationsTab,
  useOrganizationsTabUrlSync,
} from './useOrganizationsTabParams';

const ORG_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const STORED = {
  ...DEFAULT_ORGANIZATIONS_PARAMS,
  page: 3,
  sortBy: 'createdAt' as const,
  sortDirection: 'desc' as const,
  personal: true,
  search: 'Acme',
};

/** The Organizations tab as mounted: the sync hook plus a consumer reading the params. */
const renderOrganizationsTab = () =>
  renderHook(() => {
    useOrganizationsTabUrlSync();
    return useOrganizationsParams();
  });

beforeEach(() => {
  act(() => {
    useOrganizationsTab.setState({ params: { ...STORED } });
    fakeAdminRouter.reset();
  });
});

describe('Organizations tab URL precedence', () => {
  it('writes the stored view into a bare organizations URL, without the free-text search', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations' }));
    const { result } = renderOrganizationsTab();

    expect(fakeAdminRouter.search).toEqual({
      tab: 'organizations',
      orgsPage: 3,
      orgsSort: 'createdAt',
      orgsOrder: 'desc',
      orgsPersonal: true,
    });
    expect(result.current[0]).toMatchObject({ page: 3, personal: true, search: 'Acme' });
    expect(fakeAdminRouter.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ replace: true }));
  });

  it('lets a URL view win and copies it into the store for the next bare visit', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 2, orgsPersonal: false }));
    const { result } = renderOrganizationsTab();

    const expectedView = { page: 2, limit: 10, sortBy: 'name', sortDirection: 'asc', personal: false };
    // Missing view params are defaults, not the stored values: a shared link means what it says.
    expect(result.current[0]).toMatchObject(expectedView);
    expect(useOrganizationsTab.getState().params).toMatchObject({ ...expectedView, search: 'Acme' });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('reads a URL whose view params are all invalid as the default view, not the stored one', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsSort: 'credits', orgsLimit: 7 }));
    const { result } = renderOrganizationsTab();

    const defaultView = { page: 1, limit: 10, sortBy: 'name', sortDirection: 'asc', personal: undefined };
    expect(result.current[0]).toMatchObject(defaultView);
    expect(useOrganizationsTab.getState().params).toMatchObject({ ...defaultView, search: 'Acme' });
    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 1 });
  });

  it('leaves another tab URL alone', () => {
    act(() => fakeAdminRouter.reset({ tab: 'users' }));
    renderOrganizationsTab();

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
  });

  it('writes a filter change and its page reset as one URL update, keeping the open organization', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 3, orgId: ORG_ID }));
    const { result } = renderOrganizationsTab();
    fakeAdminRouter.navigate.mockClear();

    act(() => result.current[1]({ personal: undefined, page: 1 }));

    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 1, orgId: ORG_ID });
    expect(result.current[0]).toMatchObject({ page: 1, personal: undefined });
  });

  it('keeps a search-only change out of the URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 3 }));
    const { result } = renderOrganizationsTab();
    fakeAdminRouter.navigate.mockClear();

    act(() => result.current[1]({ search: 'Globex' }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(result.current[0].search).toBe('Globex');
  });

  it('keeps a late search callback from writing onto another tab', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 3 }));
    const { result } = renderOrganizationsTab();

    act(() => fakeAdminRouter.reset({ tab: 'users' }));
    act(() => result.current[1]({ search: 'Globex', page: 1 }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(fakeAdminRouter.search).toEqual({ tab: 'users' });
    expect(useOrganizationsTab.getState().params.search).toBe('Globex');
  });

  it('keeps a late search callback from navigating back to admin', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 3 }));
    const { result } = renderOrganizationsTab();

    act(() => fakeAdminRouter.reset({}, '/chat'));
    act(() => result.current[1]({ search: 'Globex', page: 1 }));

    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();
    expect(fakeAdminRouter.search).toEqual({});
    expect(useOrganizationsTab.getState().params.search).toBe('Globex');
  });
});

describe('useOpenOrganizationId', () => {
  it('opens and closes the organization through the URL', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgsPage: 2 }));
    const { result } = renderHook(() => useOpenOrganizationId());
    expect(result.current.orgId).toBeNull();

    act(() => result.current.setOrgId(ORG_ID));
    expect(result.current.orgId).toBe(ORG_ID);
    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 2, orgId: ORG_ID });

    act(() => result.current.setOrgId(null));
    expect(result.current.orgId).toBeNull();
    expect(fakeAdminRouter.search).toEqual({ tab: 'organizations', orgsPage: 2 });
  });

  it('ignores an orgId that is not an ObjectId', () => {
    act(() => fakeAdminRouter.reset({ tab: 'organizations', orgId: 'not-an-id' }));
    const { result } = renderHook(() => useOpenOrganizationId());

    expect(result.current.orgId).toBeNull();
  });
});
