import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: apiGet } }));

import {
  NEWEST_PAID_SUBSCRIPTION_QUERY,
  SUBSCRIPTIONS_LAST_SEEN_KEY,
  readStoredLastSeen,
  useNewSubscriptionsDot,
  useSubscriptionsLastSeen,
  useSubscriptionsSeenOnOpen,
} from './subscriptionsLastSeen';

const SEEN = '2026-10-01T00:00:00.000Z';

const newest = (createdAt: string | null) => ({
  data: { subscriptions: createdAt ? [{ createdAt }] : [], total: 0, page: 1, totalPages: 0, searchTruncated: false },
});

const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

beforeEach(() => {
  apiGet.mockReset();
  window.localStorage.clear();
  act(() => useSubscriptionsLastSeen.setState({ lastSeen: null }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useNewSubscriptionsDot', () => {
  it('stores now as the baseline on a first visit and shows no dot for existing rows', async () => {
    apiGet.mockResolvedValue(newest('2026-09-15T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(readStoredLastSeen()).not.toBeNull();
    expect(result.current).toBe(false);
  });

  it('lights for a Stripe subscription started after the last visit', async () => {
    window.localStorage.setItem(SUBSCRIPTIONS_LAST_SEEN_KEY, SEEN);
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: readStoredLastSeen() }));
    apiGet.mockResolvedValue(newest('2026-10-02T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/api/admin/subscriptions', { params: NEWEST_PAID_SUBSCRIPTION_QUERY });
  });

  it('stays dark when nothing started since, and never asks while disabled', async () => {
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: SEEN }));
    const disabled = renderHook(() => useNewSubscriptionsDot(false), { wrapper: wrapper() });
    expect(disabled.result.current).toBe(false);
    expect(apiGet).not.toHaveBeenCalled();

    apiGet.mockResolvedValue(newest('2026-09-30T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it('clears once the tab is opened, and hands the tab the previous visit', async () => {
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: SEEN }));
    apiGet.mockResolvedValue(newest('2026-10-02T00:00:00.000Z'));
    const dot = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(dot.result.current).toBe(true));

    const opened = renderHook(() => useSubscriptionsSeenOnOpen());
    expect(opened.result.current).toBe(SEEN);
    await waitFor(() => expect(dot.result.current).toBe(false));
    expect(Date.parse(window.localStorage.getItem(SUBSCRIPTIONS_LAST_SEEN_KEY) ?? '')).toBeGreaterThan(
      Date.parse(SEEN)
    );
  });

  it('keeps working in memory when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readStoredLastSeen()).toBeNull();

    apiGet.mockResolvedValue(newest('2026-09-15T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(useSubscriptionsLastSeen.getState().lastSeen).not.toBeNull());
    expect(result.current).toBe(false);

    const opened = renderHook(() => useSubscriptionsSeenOnOpen());
    expect(opened.result.current).not.toBeNull();
  });
});
