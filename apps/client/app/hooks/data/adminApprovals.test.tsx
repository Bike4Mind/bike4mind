import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import {
  ADMIN_APPROVALS_KEY,
  isApprovalPending,
  notifyApprovalSubmitted,
  useApproveAdminApproval,
  useAdminApprovals,
  useRejectAdminApproval,
} from './adminApprovals';

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

const post = api.post as unknown as Mock;
const ID = 'a'.repeat(24);

const setup = <T,>(hook: () => T) => {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(hook, { wrapper });
  return { result, queryClient, invalidateSpy };
};

const invalidatedKeys = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);

describe('adminApprovals hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('approve refetches the queue and the lists the approved action may have changed', async () => {
    post.mockResolvedValue({ data: { approval: { id: ID } } });
    const { result, invalidateSpy } = setup(() => useApproveAdminApproval());

    await result.current.mutateAsync(ID);

    expect(post).toHaveBeenCalledWith(`/api/admin/approvals/${ID}/approve`);
    expect(invalidatedKeys(invalidateSpy)).toEqual(
      expect.arrayContaining([['admin'], ['users'], ['organizations'], ['subscriptions']])
    );
  });

  it('approve still invalidates when the server refuses, so a stale row does not linger', async () => {
    post.mockRejectedValue(new Error('conflict'));
    const { result, invalidateSpy } = setup(() => useApproveAdminApproval());

    await expect(result.current.mutateAsync(ID)).rejects.toThrow('conflict');

    expect(invalidatedKeys(invalidateSpy)).toEqual(expect.arrayContaining([['admin']]));
  });

  it('reject sends the reason and refetches every status view of the queue', async () => {
    post.mockResolvedValue({ data: { approval: { id: ID } } });
    const { result, queryClient, invalidateSpy } = setup(() => useRejectAdminApproval());
    queryClient.setQueryData([...ADMIN_APPROVALS_KEY, 'pending'], []);
    queryClient.setQueryData([...ADMIN_APPROVALS_KEY, 'all'], []);

    await result.current.mutateAsync({ id: ID, reason: 'Not needed' });

    expect(post).toHaveBeenCalledWith(`/api/admin/approvals/${ID}/reject`, { reason: 'Not needed' });
    expect(invalidatedKeys(invalidateSpy)).toEqual([[...ADMIN_APPROVALS_KEY]]);
    expect(queryClient.getQueryState([...ADMIN_APPROVALS_KEY, 'pending'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState([...ADMIN_APPROVALS_KEY, 'all'])?.isInvalidated).toBe(true);
  });

  it('notifyApprovalSubmitted toasts and invalidates the queue', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    notifyApprovalSubmitted(queryClient);

    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('Submitted for approval'));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ADMIN_APPROVALS_KEY });
  });

  it('isApprovalPending matches only the 202 body', () => {
    expect(isApprovalPending({ approvalId: ID, status: 'pending', expiresAt: '' })).toBe(true);
    expect(isApprovalPending({ status: 'pending' })).toBe(false);
    expect(isApprovalPending({ approvalId: ID, status: 'executed' })).toBe(false);
    expect(isApprovalPending(null)).toBe(false);
  });
  it('loads the next cursor page, retaining earlier rows and resetting on a new status', async () => {
    const get = vi.mocked(api.get);
    const cursor = { before: '2026-01-01T00:00:00.000Z', beforeId: ID };
    get.mockResolvedValueOnce({ data: { approvals: [{ id: 'first' }], nextCursor: cursor } });
    get.mockResolvedValueOnce({ data: { approvals: [{ id: 'second' }], nextCursor: null } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ status }: { status: 'pending' | 'executed' }) => useAdminApprovals(status),
      {
        wrapper,
        initialProps: { status: 'pending' },
      }
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.map(row => row.id)).toEqual(['first', 'second']));
    expect(get).toHaveBeenLastCalledWith('/api/admin/approvals', { params: { status: 'pending', ...cursor } });
    get.mockResolvedValueOnce({ data: { approvals: [{ id: 'executed' }], nextCursor: null } });
    rerender({ status: 'executed' });
    await waitFor(() => expect(result.current.data?.map(row => row.id)).toEqual(['executed']));
    expect(get).toHaveBeenLastCalledWith('/api/admin/approvals', { params: { status: 'executed' } });
  });
});
