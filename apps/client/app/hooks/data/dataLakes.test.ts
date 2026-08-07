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
const apiDelete = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args), delete: (...args: unknown[]) => apiDelete(...args) },
}));
// dataLakes.ts value-imports these at module load for its OTHER hooks; useBrowsePublicDataLakes
// touches none of them, and AccountSelector alone would pull in MUI Joy plus two React contexts.
// The stub is callable (zustand-style) with a getState property: useDuplicatePrefixLake calls
// it as a selector hook, activeOrgId reads getState.
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('@client/app/components/Credits/AccountSelector', () => {
  const useSelectedAccount = (selector: (s: { selectedAccount: undefined }) => unknown) =>
    selector({ selectedAccount: undefined });
  useSelectedAccount.getState = () => ({ selectedAccount: undefined });
  return { useSelectedAccount };
});
vi.mock('@client/app/hooks/useGearsStatus', () => ({ invalidateGearsStatusWhileLocked: () => {} }));

import { useBrowsePublicDataLakes, useDuplicatePrefixLake, useRemoveFileFromDataLake } from './dataLakes';

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

describe('useRemoveFileFromDataLake cache invalidation', () => {
  it('invalidates every tag-derived view, not just the lake file list', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiDelete.mockResolvedValueOnce({ data: { success: true, fileCount: 0, totalSizeBytes: 0 } });

    const { result } = renderHook(() => useRemoveFileFromDataLake('lake1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('f1');
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['dataLakeFiles', 'lake1']));
    expect(keys).toContain(JSON.stringify(['data-lakes']));
    // Removal drops the file's tags under the lake prefix, so the tag tree and the article
    // surfaces are stale too. Bare key prefixes: both are keyed by a source discriminator,
    // and a fully-specified key would refresh only one of the two surfaces.
    expect(keys).toContain(JSON.stringify(['dataLakeTagCounts']));
    expect(keys).toContain(JSON.stringify(['dataLakeArticles']));
    // The bare file-tags prefix, not ['file-tags','counts']: the tag list itself carries a
    // fileCount derived from the files holding each tag, and invalidating only the longer
    // key leaves that list stale. Prefix matching covers the counts endpoint too.
    expect(keys).toContain(JSON.stringify(['file-tags']));
  });
});

describe('useDuplicatePrefixLake freshness', () => {
  it('refetches over a warm cache instead of trusting a stale list', async () => {
    const queryClient = new QueryClient();
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);

    // A display surface populated the cache moments ago with no colliding lake... (literal
    // key on purpose - the parity convention of this file)
    queryClient.setQueryData(['data-lakes'], []);
    // ...but a peer has since created one. The gate blocks the wizard's Next/Upload buttons,
    // so it must not trust the warm entry: its staleTime-0 override refetches on mount, and
    // the collision appears once the fresh list lands. With the list-surface defaults
    // (2 min staleTime) the warm read would be served as fresh and this test would time out.
    apiGet.mockResolvedValueOnce({
      data: { data: [{ id: 'lk1', name: 'Legal', fileTagPrefix: 'legal:', datalakeTag: 'datalake:legal' }] },
    });

    const { result } = renderHook(() => useDuplicatePrefixLake('legal:'), { wrapper });

    expect(result.current).toBeUndefined(); // the warm, collision-free list
    await waitFor(() => expect(result.current?.fileTagPrefix).toBe('legal:'));
    expect(apiGet).toHaveBeenCalledWith('/api/data-lakes');
  });
});
