import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  useGetUserOrganizations,
  useSearchOrganizations,
  useSearchUserOrganizations,
  useSetMemberCreditDefault,
  useSetMemberCreditOverride,
} from './organizations';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { put: vi.fn(), get: vi.fn() } }));

const put = api.put as unknown as Mock;

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
