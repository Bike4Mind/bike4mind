import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BrowsePublicDataLakesResult, PublicDataLakeSummary } from '@bike4mind/common';

/**
 * Offset paging for the public-lake discovery catalog. The regression this guards: `limit` used
 * to grow with each load-more (24 -> 48 -> 72), so the third click exceeded the route's max-limit
 * cap of 60 (pages/api/data-lakes/public.ts) and 422'd. `limit` must stay fixed and `offset` must
 * be what advances. 24 and 60 are deliberately literal here rather than imported from the hook /
 * the route - a self-referential assertion could not observe the regression.
 */

const apiGet = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));
// dataLakes.ts value-imports these at module load for its OTHER hooks; the browse hook touches
// none of them, and AccountSelector alone would pull in MUI Joy plus two React contexts.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: { getState: () => ({ selectedAccount: undefined }) },
}));
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

import { useBrowsePublicDataLakes } from './dataLakes';

const PAGE_SIZE = 24;

const summary = (id: string): PublicDataLakeSummary => ({
  id,
  slug: `lake-${id}`,
  name: `Lake ${id}`,
  fileTagPrefix: 'lake:',
  fileCount: 0,
  totalSizeBytes: 0,
  isOwn: false,
  canManage: false,
});

// api.get is axios-shaped, so the payload is double-nested: { data: { data, total } }.
const pageResponse = (count: number, total: number, startAt = 0): { data: BrowsePublicDataLakesResult } => ({
  data: {
    data: Array.from({ length: count }, (_, i) => summary(`lk${startAt + i}`)),
    total,
  },
});

const mountBrowse = (initialSearch = '') => {
  // A fresh client per mount - a shared one would serve the next test from cache and fire no request.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(({ search }: { search: string }) => useBrowsePublicDataLakes(search), {
    wrapper,
    initialProps: { search: initialSearch },
  });
};

const requestedUrls = (): string[] => apiGet.mock.calls.map(call => call[0] as string);
const paramsOf = (url: string) => new URL(url, 'http://test.local').searchParams;

describe('useBrowsePublicDataLakes', () => {
  beforeEach(() => {
    // mockReset (not mockClear) so a previous test's mockResolvedValueOnce queue cannot leak.
    apiGet.mockReset();
    apiGet.mockResolvedValue(pageResponse(PAGE_SIZE, 100));
  });

  it('requests the first page at a fixed limit and offset 0', async () => {
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()).toEqual(['/api/data-lakes/public?limit=24&offset=0']);
  });

  it('trims the search term and sends it as q', async () => {
    const { result } = mountBrowse('  sales  ');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requestedUrls()[0]).toBe('/api/data-lakes/public?q=sales&limit=24&offset=0');
  });

  it('omits q entirely for a whitespace-only search', async () => {
    const { result } = mountBrowse('   ');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(paramsOf(requestedUrls()[0]).has('q')).toBe(false);
  });

  it('advances offset, not limit, on the second page', async () => {
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(requestedUrls()[1]).toBe('/api/data-lakes/public?limit=24&offset=24');
  });

  it('keeps limit fixed across a deep load-more', async () => {
    apiGet
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 0))
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 24))
      .mockResolvedValueOnce(pageResponse(PAGE_SIZE, 100, 48));

    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));

    const limits = requestedUrls().map(url => paramsOf(url).get('limit'));
    const offsets = requestedUrls().map(url => paramsOf(url).get('offset'));

    // The old bug summed the page size into `limit` (24 -> 48 -> 72), so the THIRD load-more blew
    // past the route's max of 60 (public.ts:12). Assert the cap itself, before the exact-equality
    // check below, so a regression fails on the real consequence rather than on equality alone.
    limits.forEach(limit => expect(Number(limit)).toBeLessThanOrEqual(60));
    expect(limits).toEqual(['24', '24', '24']);
    expect(offsets).toEqual(['0', '24', '48']);
  });

  it('stops paging once the loaded count reaches the total', async () => {
    apiGet.mockResolvedValue(pageResponse(10, 10));
    const { result } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('restarts at offset 0 when the search term changes', async () => {
    const { result, rerender } = mountBrowse('');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    rerender({ search: 'sales' });
    // keepPreviousData holds the prior pages for a tick, so gate on the recorded request rather
    // than on result.current.data.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
    expect(requestedUrls()[2]).toBe('/api/data-lakes/public?q=sales&limit=24&offset=0');
  });
});
