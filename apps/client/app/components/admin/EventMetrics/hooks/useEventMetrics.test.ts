import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, AxiosHeaders } from 'axios';
import { api } from '@client/app/contexts/ApiContext';
import { useEventMetrics } from './useEventMetrics';
import type { EventMetric } from '../types';

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn() },
}));

const staleMetrics: EventMetric[] = [
  {
    id: 'stale-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    eventName: 'chat_message',
    eventCategory: 'chat',
    user: { userId: 'u1', userName: 'stale-user', userLevel: 'member' },
    counterValue: 1,
  },
];

const freshMetrics: EventMetric[] = [
  {
    id: 'fresh-1',
    timestamp: '2026-01-02T00:00:00.000Z',
    eventName: 'chat_message',
    eventCategory: 'chat',
    user: { userId: 'u2', userName: 'fresh-user', userLevel: 'member' },
    counterValue: 2,
  },
];

const rateLimitError = () =>
  new AxiosError('Request failed with status code 429', 'ERR_BAD_REQUEST', undefined, null, {
    status: 429,
    statusText: 'Too Many Requests',
    data: { error: 'Too many requests' },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const isRecacheUrl = (url: string) => url.includes('recache=true');

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
}

beforeEach(() => {
  vi.mocked(api.get).mockReset();
});

describe('useEventMetrics forceRefresh', () => {
  it('keeps a failed recache visible over the stale data instead of a papered-over refetch', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return Promise.reject(rateLimitError());
      }
      return Promise.resolve({ data: staleMetrics });
    });

    const { result } = renderHook(() => useEventMetrics(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(staleMetrics));

    act(() => {
      result.current.forceRefresh();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.error).toBeInstanceOf(AxiosError);
    expect((result.current.error as AxiosError).response?.status).toBe(429);
    expect(result.current.data).toEqual(staleMetrics);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('seeds the cache from the recache response on success, with no extra read', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return Promise.resolve({ data: freshMetrics });
      }
      return Promise.resolve({ data: staleMetrics });
    });

    const { result } = renderHook(() => useEventMetrics(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.data).toEqual(staleMetrics));

    act(() => {
      result.current.forceRefresh();
    });

    await waitFor(() => expect(result.current.data).toEqual(freshMetrics));

    expect(result.current.isError).toBe(false);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('reports isFetching while the recache is in flight, for both a success and a failure settle', async () => {
    let resolveSuccess: (() => void) | undefined;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return new Promise((resolve, reject) => {
          resolveSuccess = () => resolve({ data: freshMetrics });
          void reject;
        });
      }
      return Promise.resolve({ data: staleMetrics });
    });

    const { result } = renderHook(() => useEventMetrics(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toEqual(staleMetrics));

    act(() => {
      result.current.forceRefresh();
    });

    await waitFor(() => expect(result.current.isFetching).toBe(true));

    act(() => {
      resolveSuccess?.();
    });

    await waitFor(() => expect(result.current.isFetching).toBe(false));

    let rejectFailure: ((err: unknown) => void) | undefined;
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return new Promise((_resolve, reject) => {
          rejectFailure = reject;
        });
      }
      return Promise.resolve({ data: freshMetrics });
    });

    act(() => {
      result.current.forceRefresh();
    });

    await waitFor(() => expect(result.current.isFetching).toBe(true));

    act(() => {
      rejectFailure?.(rateLimitError());
    });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.isError).toBe(true);
  });

  it('does not carry a failed recache banner over to a freshly loaded, different filter set', async () => {
    const filtersA = { userFilter: 'alice' };
    const filtersB = { userFilter: 'bob' };

    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return Promise.reject(rateLimitError());
      }
      return Promise.resolve({ data: staleMetrics });
    });

    const { result, rerender } = renderHook(({ filters }) => useEventMetrics(filters), {
      wrapper: makeWrapper(),
      initialProps: { filters: filtersA },
    });

    await waitFor(() => expect(result.current.data).toEqual(staleMetrics));

    act(() => {
      result.current.forceRefresh();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    vi.mocked(api.get).mockImplementation((url: string) => {
      if (isRecacheUrl(url)) {
        return Promise.reject(rateLimitError());
      }
      return Promise.resolve({ data: freshMetrics });
    });

    rerender({ filters: filtersB });

    await waitFor(() => expect(result.current.data).toEqual(freshMetrics));
    expect(result.current.isError).toBe(false);
  });
});
