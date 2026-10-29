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

const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const wrapper = (client = createClient()) => {
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useNewSubscriptionsDot', () => {
  it('takes the newest row as the baseline on a first visit and shows no dot for it', async () => {
    apiGet.mockResolvedValue(newest('2026-09-15T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(readStoredLastSeen()).toBe('2026-09-15T00:00:00.000Z'));
    expect(useSubscriptionsLastSeen.getState().lastSeen).toBe('2026-09-15T00:00:00.000Z');
    expect(result.current).toBe(false);
  });

  it('ignores a skewed browser clock on a first visit', async () => {
    // A clock years behind would make every existing row look new if it were the baseline.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    const client = createClient();
    apiGet.mockResolvedValue(newest('2026-09-15T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper(client) });
    await waitFor(() => expect(useSubscriptionsLastSeen.getState().lastSeen).toBe('2026-09-15T00:00:00.000Z'));
    expect(result.current).toBe(false);

    // A clock years ahead would hide this one.
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    apiGet.mockResolvedValue(newest('2026-09-16T00:00:00.000Z'));
    await act(() => client.refetchQueries());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('lights for the first paid row when there were none at the first visit', async () => {
    const client = createClient();
    apiGet.mockResolvedValue(newest(null));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper(client) });
    await waitFor(() => expect(useSubscriptionsLastSeen.getState().lastSeen).toBe(new Date(0).toISOString()));
    expect(result.current).toBe(false);

    apiGet.mockResolvedValue(newest('2026-09-16T00:00:00.000Z'));
    await act(() => client.refetchQueries());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('clears when another browser tab opens the Subscriptions tab', async () => {
    act(() => useSubscriptionsLastSeen.setState({ lastSeen: SEEN }));
    apiGet.mockResolvedValue(newest('2026-10-02T00:00:00.000Z'));
    const { result } = renderHook(() => useNewSubscriptionsDot(true), { wrapper: wrapper() });
    await waitFor(() => expect(result.current).toBe(true));

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: '2026-10-03T00:00:00.000Z' }));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: SUBSCRIPTIONS_LAST_SEEN_KEY, newValue: '2026-10-03T00:00:00.000Z' })
      );
    });
    expect(result.current).toBe(false);
    expect(useSubscriptionsLastSeen.getState().lastSeen).toBe('2026-10-03T00:00:00.000Z');
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
