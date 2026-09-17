import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { useCancelSubscription } from './subscriptions';

/**
 * The cancel route returns Stripe's own `status` so the cached row stops reading as a
 * live plan the moment it is cancelled. Nothing else exercises that cache patch: the
 * components that render the result are tested against rows built by hand, so deleting
 * the patch leaves every other test green.
 */

const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args), put: vi.fn(), get: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const row = (overrides: Partial<IUserSubscription> = {}) =>
  ({
    subscriptionId: 'sub_1',
    priceId: 'price_pro',
    status: 'active',
    canceledAt: null,
    periodStartsAt: new Date('2026-01-01T00:00:00Z'),
    periodEndsAt: new Date('2026-02-01T00:00:00Z'),
    ...overrides,
  }) as unknown as IUserSubscription;

const setup = (rows: IUserSubscription[]) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<IUserSubscription[]>(['subscriptions'], rows);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = 'TestQueryClientWrapper';
  const { result } = renderHook(() => useCancelSubscription(), { wrapper: Wrapper });
  return { result, queryClient };
};

const cached = (queryClient: QueryClient) => queryClient.getQueryData<IUserSubscription[]>(['subscriptions']) ?? [];

describe('useCancelSubscription', () => {
  beforeEach(() => {
    apiPost.mockReset();
  });

  it("patches Stripe's status into the cached row so it stops showing as a live plan", async () => {
    apiPost.mockResolvedValue({
      data: {
        subscriptionId: 'sub_1',
        priceId: 'price_pro',
        status: 'canceled',
        canceledAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    const { result, queryClient } = setup([row()]);

    result.current.mutate('price_pro');

    await waitFor(() => expect(cached(queryClient)[0].status).toBe('canceled'));
    expect(cached(queryClient)[0].canceledAt).toEqual(new Date('2026-02-01T00:00:00Z'));
  });

  it('patches only the cancelled row when two rows share a price', async () => {
    // A re-subscribe after a failed renewal leaves a stale delinquent row beside the
    // live one at the same priceId. Matching on priceId would write the live row's
    // status onto both and hide the payment issue the user has to act on.
    apiPost.mockResolvedValue({
      data: {
        subscriptionId: 'sub_live',
        priceId: 'price_pro',
        status: 'canceled',
        canceledAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    const stale = row({ subscriptionId: 'sub_stale', status: 'past_due' });
    const live = row({ subscriptionId: 'sub_live' });
    const { result, queryClient } = setup([stale, live]);

    result.current.mutate('price_pro');

    await waitFor(() =>
      expect(cached(queryClient).find(sub => sub.subscriptionId === 'sub_live')?.status).toBe('canceled')
    );
    expect(cached(queryClient).find(sub => sub.subscriptionId === 'sub_stale')?.status).toBe('past_due');
  });
});
