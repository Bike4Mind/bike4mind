import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AdminSubscriptionDetail } from '@client/app/utils/adminSubscriptionDetail';
import {
  adminSubscriptionDetailKey,
  useAdminSubscriptionCancel,
  useAdminSubscriptionResume,
} from './adminSubscriptionDetail';

const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args), get: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ID = 'a'.repeat(24);
const body = { reason: 'Customer request', idempotencyKey: 'idem-key-0001', expectedState: 'state-1' };
const NEW_STRIPE = { lastSyncedAt: '2026-11-04T10:00:00.000Z', cancelAtPeriodEnd: true, stateToken: 'state-2' };

const setup = (hook: typeof useAdminSubscriptionCancel) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(adminSubscriptionDetailKey(ID), {
    subscription: { id: ID, status: 'active' },
    stripe: { lastSyncedAt: null, cancelAtPeriodEnd: false, stateToken: 'state-1' },
  } as unknown as AdminSubscriptionDetail);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryClientWrapper';
  const { result } = renderHook(() => hook(ID), { wrapper: Wrapper });
  return { result, queryClient, invalidate };
};

describe.each([
  ['cancel', useAdminSubscriptionCancel],
  ['resume', useAdminSubscriptionResume],
])('use admin subscription %s', (path, hook) => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it('posts the body to its own endpoint and writes the response into the cached detail', async () => {
    apiPost.mockResolvedValue({ data: { subscription: { id: ID, status: 'active' }, stripe: NEW_STRIPE } });
    const { result, queryClient, invalidate } = setup(hook);

    await result.current.mutateAsync(body);

    expect(apiPost).toHaveBeenCalledWith(`/api/admin/subscriptions/${ID}/${path}`, body);
    const cached = queryClient.getQueryData<AdminSubscriptionDetail>(adminSubscriptionDetailKey(ID));
    expect(cached?.stripe).toEqual(NEW_STRIPE);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'subscriptions'] });
  });

  it('rejects on error and refetches the detail so a retry reviews fresh state', async () => {
    apiPost.mockImplementation(async () => {
      throw new Error('This subscription changed. Review and try again.');
    });
    const { result, invalidate } = setup(hook);
    await act(async () => {
      await expect(result.current.mutateAsync(body)).rejects.toThrow('changed');
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: adminSubscriptionDetailKey(ID) }));
  });
});
