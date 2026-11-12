import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { organizationMemberRole } from '@bike4mind/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { fabFileKeys } from './fabFileKeys';
import { dataLakeKeys } from './dataLakeKeys';
import {
  removedMembersMessage,
  useGetOrganization,
  useGetUserOrganizations,
  useMemberOffboardingInventory,
  useRemoveMemberFromOrganization,
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
const get = api.get as unknown as Mock;
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
    ['single organization', () => useGetOrganization('org1')],
    ['user organizations', () => useGetUserOrganizations('user1')],
    ['organization search', () => useSearchOrganizations({ page: 1, limit: 16, search: '' })],
    ['user organization search', () => useSearchUserOrganizations('user1', '')],
  ] as const)('%s does not fan out a late response after cancellation', async (_name, useHook) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const organizationKey = ['organizations', 'org1'];
    queryClient.setQueryData(organizationKey, { id: 'org1', currentCredits: 100 }, { updatedAt: 0 });
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

describe('member removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('keeps the single-removal messages', () => {
    expect(removedMembersMessage([undefined])).toBe('Member removed successfully');
    expect(removedMembersMessage([0])).toBe('Member removed successfully');
    expect(removedMembersMessage([1])).toBe(
      'Member removed. 1 share on personal data lakes was kept; the lake owners are being notified.'
    );
    expect(removedMembersMessage([null])).toBe(
      'Member removed. Personal data lake shares could not be checked, so the lake owners were not notified.'
    );
  });

  it('sums a bulk removal into one message', () => {
    expect(removedMembersMessage([0, undefined])).toBe('2 members removed');
    expect(removedMembersMessage([2, 1, null])).toBe(
      '3 members removed. 3 shares on personal data lakes were kept; the lake owners are being notified. ' +
        'Personal data lake shares could not be checked for 1 of them, so those lake owners were not notified.'
    );
  });

  it('toasts each removal unless asked to stay quiet', async () => {
    del.mockResolvedValue({ data: { id: 'org1', personalLakeSharesKept: 0 } });
    const { result } = renderWithClient(useRemoveMemberFromOrganization);

    await expect(result.current.mutateAsync({ organizationId: 'org1', userId: 'u1' })).resolves.toBe(0);
    expect(del).toHaveBeenCalledWith('/api/organizations/org1/members/u1', undefined);
    expect(toast.success).toHaveBeenCalledWith('Member removed successfully');

    vi.mocked(toast.success).mockClear();
    await result.current.mutateAsync({ organizationId: 'org1', userId: 'u2', quiet: true });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a failed removal unless asked to stay quiet', async () => {
    del.mockRejectedValue(new Error('boom'));
    const { result } = renderWithClient(useRemoveMemberFromOrganization);

    await expect(result.current.mutateAsync({ organizationId: 'org1', userId: 'u1' })).rejects.toThrow('boom');
    expect(toast.error).toHaveBeenCalledWith('Failed to remove member: boom');

    vi.mocked(toast.error).mockClear();
    await expect(result.current.mutateAsync({ organizationId: 'org1', userId: 'u1', quiet: true })).rejects.toThrow(
      'boom'
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('member offboarding ownership caches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    del.mockResolvedValue({ data: { id: 'org1', personalLakeSharesKept: 0 } });
  });

  it.each([false, true])('refreshes transferred content caches only when transfer is %s', async transferring => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity }, mutations: { retry: false } },
    });
    const contentKeys = [
      fabFileKeys.doc('file1'),
      ['projects', 'project1'],
      ['projects', 'search', { search: 'Roadmap' }],
      ['joined-projects', 'owner'],
      ['sessions', 'own', 'owner'],
      ['sessions', 'notebook1'],
      ['own-session-count'],
      ['agents'],
      ['session-agents', 'notebook1'],
      ['artifact', 'artifact1'],
      ['session-artifacts', 'notebook1'],
    ] as const;
    const membershipKeys = [['users', 'organization', 'org1'], ['organizations', 'org1'], dataLakeKeys.list] as const;
    for (const queryKey of [...contentKeys, ...membershipKeys, ['unrelated']]) {
      queryClient.setQueryData(queryKey, { id: 'cached' });
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const view = renderHook(useRemoveMemberFromOrganization, { wrapper });
    try {
      await act(async () => {
        await view.result.current.mutateAsync({
          organizationId: 'org1',
          userId: 'member',
          ...(transferring ? { reassignTo: 'owner' } : {}),
        });
      });
      for (const queryKey of contentKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated, JSON.stringify(queryKey)).toBe(transferring);
      }
      for (const queryKey of membershipKeys) {
        expect(queryClient.getQueryState(queryKey)?.isInvalidated, JSON.stringify(queryKey)).toBe(true);
      }
      expect(queryClient.getQueryState(['unrelated'])?.isInvalidated).toBe(false);
      expect(del).toHaveBeenCalledWith(
        '/api/organizations/org1/members/member',
        transferring ? { data: { reassignTo: 'owner' } } : undefined
      );
    } finally {
      view.unmount();
      queryClient.clear();
    }
  });
});

describe('member offboarding inventory after removal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const removed = { id: 'org1', userId: 'owner', users: [{ userId: 'other', permissions: ['read'] }] };
    del.mockResolvedValue({ data: { ...removed, personalLakeSharesKept: 0 } });
    get.mockImplementation(async (url: string) => ({
      data: url === '/api/organizations/org1' ? removed : { files: { count: 0, sample: [] } },
    }));
  });

  it('suppresses removed-member reads and reloads a re-added member despite retained mutation history', async () => {
    const idleCallbacks: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    for (let index = 0; index < 11; index += 1) {
      queryClient.setQueryData(['organizations', 'cached', index], { id: 'org1' });
    }
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    queryClient.setQueryData(['organizations', 'org1'], {
      id: 'org1',
      userId: 'owner',
      users: [
        { userId: 'member', permissions: [] },
        { userId: 'other', permissions: ['read'] },
      ],
    });
    const view = renderHook(
      ({ userId }: { userId: string | null }) => {
        const organization = useGetOrganization('org1');
        return {
          inventory: useMemberOffboardingInventory('org1', userId, {
            enabled: !!userId && !!organization.data && organizationMemberRole(organization.data, userId) !== null,
          }),
          removeMember: useRemoveMemberFromOrganization(),
        };
      },
      { wrapper, initialProps: { userId: 'member' as string | null } }
    );
    const inventoryUrl = (userId: string) => `/api/organizations/org1/members/${userId}/offboarding`;
    const inventoryFetches = (userId: string) => get.mock.calls.filter(([url]) => url === inventoryUrl(userId)).length;
    try {
      await waitFor(() => expect(view.result.current.inventory.isSuccess).toBe(true));
      expect(inventoryFetches('member')).toBe(1);

      await act(async () => {
        await view.result.current.removeMember.mutateAsync({ organizationId: 'org1', userId: 'member' });
      });
      expect(idleCallbacks).toHaveLength(0);
      expect(queryClient.getQueryData(['organizations', 'org1'])).toMatchObject({
        users: [{ userId: 'other', permissions: ['read'] }],
      });
      view.rerender({ userId: 'member' });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });

      expect(inventoryFetches('member')).toBe(1);
      expect(view.result.current.inventory.fetchStatus).toBe('idle');

      view.rerender({ userId: 'other' });
      await waitFor(() => expect(inventoryFetches('other')).toBe(1));
      view.rerender({ userId: null });
      await act(async () => {
        queryClient.setQueryData(['organizations', 'org1'], {
          id: 'org1',
          userId: 'owner',
          users: [
            { userId: 'member', permissions: [] },
            { userId: 'other', permissions: ['read'] },
          ],
        });
      });
      expect(
        queryClient.getMutationCache().findAll({ mutationKey: ['organizations', 'remove-member'], status: 'success' })
      ).toHaveLength(1);
      view.rerender({ userId: 'member' });
      await waitFor(() => expect(inventoryFetches('member')).toBe(2));
      await waitFor(() => expect(view.result.current.inventory.isSuccess).toBe(true));
    } finally {
      view.unmount();
      queryClient.clear();
      vi.unstubAllGlobals();
    }
  });
});
