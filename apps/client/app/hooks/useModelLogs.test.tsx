import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.hoisted(() => vi.fn());
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get } }));

import { useModelLogDetail, useModelLogs } from './useModelLogs';

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const requestedParams = () => new URL(get.mock.calls[get.mock.calls.length - 1][0], 'http://x').searchParams;

describe('useModelLogs', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { logs: [], total: 0, page: 1, limit: 10 } });
  });

  it('sends page, limit and every set filter', async () => {
    renderHook(
      () =>
        useModelLogs({
          startDate: '2026-10-01',
          endDate: '2026-10-07',
          model: 'gpt-4',
          search: 'retry',
          page: 3,
          limit: 25,
        }),
      { wrapper }
    );

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get.mock.calls[0][0]).toMatch(/^\/api\/admin\/model-logs\?/);
    expect(Object.fromEntries(requestedParams())).toEqual({
      page: '3',
      limit: '25',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      model: 'gpt-4',
      search: 'retry',
    });
  });

  it('leaves unset filters out of the query string', async () => {
    renderHook(() => useModelLogs({ page: 1, limit: 10 }), { wrapper });

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(Object.fromEntries(requestedParams())).toEqual({ page: '1', limit: '10' });
  });

  it('refetches when the page changes', async () => {
    const { rerender } = renderHook(({ page }) => useModelLogs({ page, limit: 10 }), {
      wrapper,
      initialProps: { page: 1 },
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    rerender({ page: 2 });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(requestedParams().get('page')).toBe('2');
  });
});

describe('useModelLogDetail', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { id: 'a/b' } });
  });

  it('does not fetch while disabled', async () => {
    const { result } = renderHook(() => useModelLogDetail('log-1', false), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(get).not.toHaveBeenCalled();
  });

  it('fetches the encoded id once enabled', async () => {
    const { result } = renderHook(() => useModelLogDetail('a/b', true), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ id: 'a/b' }));
    expect(get).toHaveBeenCalledWith('/api/admin/model-logs/a%2Fb');
  });
});
