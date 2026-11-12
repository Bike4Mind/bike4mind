import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  useDeleteOrganization,
  useGetOrganization,
  useGetUserOrganizations,
  useOrganizationInvites,
  useSearchOrganizations,
  useSearchUserOrganizations,
  useSetMemberCreditDefault,
  useSetMemberCreditOverride,
  useSetOrganizationManager,
  useTransferOrganizationOwnership,
} from './organizations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { put: vi.fn(), get: vi.fn(), delete: vi.fn(), post: vi.fn() },
}));

const put = api.put as unknown as Mock;
const del = api.delete as unknown as Mock;
const post = api.post as unknown as Mock;

const renderWithClient = <T,>(useHook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  return { result, invalidateSpy };
};

describe('credit budget mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue({ data: { id: 'org1' } });
  });

  it('useSetMemberCreditDefault PUTs maxCreditsPerMember and invalidates organizations', async () => {
    const { result, invalidateSpy } = renderWithClient(useSetMemberCreditDefault);

    await result.current.mutateAsync({ organizationId: 'org1', maxCreditsPerMember: 500 });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/member-credit-budget', { maxCreditsPerMember: 500 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
    expect(toast.success).toHaveBeenCalledWith('Monthly credit limit updated');
  });

  it('useSetMemberCreditDefault sends null to remove the limit', async () => {
    const { result } = renderWithClient(useSetMemberCreditDefault);

    await result.current.mutateAsync({ organizationId: 'org1', maxCreditsPerMember: null });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/member-credit-budget', { maxCreditsPerMember: null });
  });

  it('useSetMemberCreditOverride PUTs maxCredits for one member and invalidates organizations', async () => {
    const { result, invalidateSpy } = renderWithClient(useSetMemberCreditOverride);

    await result.current.mutateAsync({ organizationId: 'org1', userId: 'user1', maxCredits: 0 });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/members/user1/credit-budget', { maxCredits: 0 });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
  });

  it.each([
    ['useSetMemberCreditDefault', useSetMemberCreditDefault, { organizationId: 'org1', maxCreditsPerMember: 5 }],
    [
      'useSetMemberCreditOverride',
      useSetMemberCreditOverride,
      { organizationId: 'org1', userId: 'user1', maxCredits: 5 },
    ],
  ] as const)(
    '%s rejects, toasts the failure and does not invalidate when the request fails',
    async (_name, useHook, variables) => {
      put.mockRejectedValue(new Error('boom'));
      const { result, invalidateSpy } = renderWithClient(useHook);

      await expect(result.current.mutateAsync(variables as never)).rejects.toThrow('boom');

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('boom')));
      expect(toast.success).not.toHaveBeenCalled();
      expect(invalidateSpy).not.toHaveBeenCalled();
    }
  );
});

describe('cancelled organization refreshes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finishes user organization fanout before returning, even with more than ten cached queries', async () => {
    const idleCallbacks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (let index = 0; index < 11; index += 1) {
      queryClient.setQueryData(['organizations', 'cached', index], { id: 'org1', currentCredits: 100 });
    }
    vi.mocked(api.get).mockResolvedValueOnce({
      data: { data: [{ id: 'org1', currentCredits: 20 }], hasMore: false, total: 1 },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useGetUserOrganizations('user1'), { wrapper });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    const lastKey = ['organizations', 'cached', 10];
    expect(queryClient.getQueryData(lastKey)).toEqual({ id: 'org1', currentCredits: 20 });

    // A newer turn writes its balance after the old query completed. No old idle batch may undo it.
    queryClient.setQueryData(lastKey, { id: 'org1', currentCredits: 30 });
    await queryClient.cancelQueries({ queryKey: ['organizations'] });
    while (idleCallbacks.length > 0) idleCallbacks.shift()?.();
    expect(queryClient.getQueryData(lastKey)).toEqual({ id: 'org1', currentCredits: 30 });
    view.unmount();
    queryClient.clear();
  });

  it.each([
    ['user organizations', () => useGetUserOrganizations('user1')],
    ['organization search', () => useSearchOrganizations({ page: 1, limit: 16, search: '' })],
    ['user organization search', () => useSearchUserOrganizations('user1', '')],
  ] as const)('%s does not fan out a late response after cancellation', async (_name, useHook) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const organizationKey = ['organizations', 'org1'];
    queryClient.setQueryData(organizationKey, { id: 'org1', currentCredits: 100 });
    let resolveResponse!: (response: {
      data: { data: { id: string; currentCredits: number }[]; hasMore: boolean; total: number };
    }) => void;
    vi.mocked(api.get).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveResponse = resolve;
        })
    );
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const view = renderHook(useHook as () => unknown, { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    const requestOptions: unknown = vi.mocked(api.get).mock.calls[0]?.[1];

    await act(async () => {
      await queryClient.cancelQueries({ queryKey: ['organizations'] });
      resolveResponse({ data: { data: [{ id: 'org1', currentCredits: 20 }], hasMore: false, total: 1 } });
      await Promise.resolve();
    });

    expect(queryClient.getQueryData(organizationKey)).toEqual({ id: 'org1', currentCredits: 100 });
    expect(requestOptions).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    view.unmount();
    queryClient.clear();
  });
});

describe('manager and ownership mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    put.mockResolvedValue({ data: { id: 'org1' } });
    del.mockResolvedValue({ data: { id: 'org1' } });
    post.mockResolvedValue({ data: { organizationId: 'org1', ownerId: 'u1' } });
  });

  it('useSetOrganizationManager PUTs to appoint and never DELETEs', async () => {
    const { result, invalidateSpy } = renderWithClient(useSetOrganizationManager);

    await result.current.mutateAsync({ organizationId: 'org1', userId: 'u1', isManager: true });

    expect(put).toHaveBeenCalledWith('/api/organizations/org1/members/u1/manager');
    expect(del).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
    expect(toast.success).toHaveBeenCalledWith('Member is now a manager');
  });

  it('useSetOrganizationManager DELETEs to remove and never PUTs', async () => {
    const { result } = renderWithClient(useSetOrganizationManager);

    await result.current.mutateAsync({ organizationId: 'org1', userId: 'u1', isManager: false });

    expect(del).toHaveBeenCalledWith('/api/organizations/org1/members/u1/manager');
    expect(put).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Manager removed');
  });

  it('useTransferOrganizationOwnership POSTs the new owner and refetches the org and its roster', async () => {
    const { result, invalidateSpy } = renderWithClient(useTransferOrganizationOwnership);

    await result.current.mutateAsync({ organizationId: 'org1', newOwnerId: 'u1' });

    expect(post).toHaveBeenCalledWith('/api/organizations/org1/transfer-ownership', { newOwnerId: 'u1' });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['organizations'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['users', 'organization'] });
  });
});

describe('useDeleteOrganization', () => {
  const get = api.get as unknown as Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    del.mockResolvedValue({ data: {} });
    get.mockResolvedValue({ data: [] });
  });

  it('does not refetch org-scoped queries of the deleted org while its page is still mounted', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => ({ invites: useOrganizationInvites('org1'), remove: useDeleteOrganization() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.invites.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await view.result.current.remove.mutateAsync('org1');
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(get).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Organization deleted successfully');
  });

  it('does not refetch the deleted org detail either while its page is still mounted', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    get.mockResolvedValue({ data: { id: 'org1' } });
    const view = renderHook(() => ({ org: useGetOrganization('org1'), remove: useDeleteOrganization() }), { wrapper });
    await waitFor(() => expect(view.result.current.org.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      await view.result.current.remove.mutateAsync('org1');
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('drops the deleted org from the cached org list before any refetch lands', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    get.mockResolvedValueOnce({
      data: {
        data: [
          { id: 'org1', name: 'One' },
          { id: 'org2', name: 'Two' },
        ],
        hasMore: false,
        total: 2,
      },
    });
    get.mockImplementation(() => new Promise(() => undefined));
    const view = renderHook(() => ({ list: useGetUserOrganizations('u1'), remove: useDeleteOrganization() }), {
      wrapper,
    });
    await waitFor(() => expect(view.result.current.list.isSuccess).toBe(true));

    await act(async () => {
      await view.result.current.remove.mutateAsync('org1');
    });

    expect(queryClient.getQueryData<{ id: string }[]>(['organizations', 'user', 'u1'])?.map(o => o.id)).toEqual([
      'org2',
    ]);
  });

  it('still refetches other organization queries', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(useDeleteOrganization, { wrapper });

    await act(async () => {
      await result.current.mutateAsync('org1');
    });

    const { predicate } = invalidateSpy.mock.calls[0][0] as { predicate: (q: { queryKey: unknown[] }) => boolean };
    expect(predicate({ queryKey: ['organizations'] })).toBe(true);
    expect(predicate({ queryKey: ['organizations', 'org2', 'invites'] })).toBe(true);
    expect(predicate({ queryKey: ['organizations', 'org1', 'invites'] })).toBe(false);
  });
});
