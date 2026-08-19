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
const apiPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
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

import {
  __resetPurgingLakesForTests,
  INITIAL_REBUILD_POLL_STATE,
  nextRebuildPoll,
  useBrowsePublicDataLakes,
  useCleanupDataLake,
  useDataLakeSpend,
  useDuplicatePrefixLake,
  useGetDeletedDataLakes,
  useRemoveFileFromDataLake,
  useRechunkDataLake,
} from './dataLakes';

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

/**
 * The purge is queued, not done: POST .../lifecycle {action:'cleanup'} answers 202 and the sweep
 * runs in a background consumer, so GET /api/data-lakes/deleted still returns the lake for a
 * while afterwards. That is why these tests mock the endpoint to keep returning BOTH lakes - a
 * refetch on the purge path is guaranteed to see the pre-sweep truth and put the row back (#1487).
 */
describe('useCleanupDataLake queued purge', () => {
  const deletedLake = (id: string) => ({ id, name: `Lake ${id}`, fileTagPrefix: `${id}:` });
  const listing = (...ids: string[]) => ({ data: { data: ids.map(deletedLake) } });

  // The pending-purge map behind this behavior is module-scoped (session-scoped by design: it must
  // survive the Deleted section remounting), so it is reset per case below. Ids stay distinct per
  // case anyway, so a leak would show up as a wrong assertion rather than as passing by luck.
  const mountPurgeSurface = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    const view = renderHook(() => ({ deleted: useGetDeletedDataLakes(true), cleanup: useCleanupDataLake() }), {
      wrapper,
    });
    return { ...view, queryClient, invalidate };
  };

  // Any refetch the purge triggers resolves immediately here, so one macrotask is enough for it
  // to have landed - which is what makes "it never happened" a real assertion rather than a race.
  const settle = () =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });

  const deletedFetchCount = () => apiGet.mock.calls.filter(call => call[0] === '/api/data-lakes/deleted').length;

  beforeEach(() => {
    __resetPurgingLakesForTests();
    apiGet.mockReset();
    apiPost.mockReset();
    apiPost.mockResolvedValue({ data: { success: true, queued: true } });
  });

  it('removes the purged lake from the expanded list and keeps it gone', async () => {
    apiGet.mockResolvedValue(listing('lk1', 'lk2'));
    const { result, invalidate } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk1');
    });
    await settle();

    expect(apiPost).toHaveBeenCalledWith('/api/data-lakes/lk1/lifecycle', { action: 'cleanup' });
    expect(result.current.deleted.data).toEqual([deletedLake('lk2')]);
    // Exactly the mount fetch: a second GET would have re-added the still-soft-deleted lk1.
    expect(deletedFetchCount()).toBe(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates no key that prefix-matches the deleted list', async () => {
    apiGet.mockResolvedValue(listing('lk3', 'lk4'));
    const { result, invalidate } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk3');
    });
    await settle();

    // Literal keys on purpose (the parity convention of this file). ['data-lakes'] is the trap:
    // it PREFIX-matches ['data-lakes','deleted'], so invalidating the lake list here would
    // refetch the deleted list and undo the removal above just as surely as naming it directly.
    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).not.toContain(JSON.stringify(['data-lakes']));
    expect(keys).not.toContain(JSON.stringify(['data-lakes', 'deleted']));
  });

  it('stays gone when a sibling mutation refetches the list before the sweep has run', async () => {
    // The realistic trigger: every other lake mutation invalidates dataLakeKeys.list, which
    // prefix-matches this key, and re-expanding the section refetches too. The server still lists
    // the lake for the whole sweep window, so the cache write alone would be undone here.
    apiGet.mockResolvedValue(listing('lk5', 'lk6'));
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk5');
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await settle();

    expect(deletedFetchCount()).toBe(2); // the refetch really happened
    expect(result.current.deleted.data).toEqual([deletedLake('lk6')]);
  });

  it('lets a fetch that was already in flight land, and still hides the purged row', async () => {
    // Ordering the other way round from the test above: a sibling mutation (e.g. restoring another
    // lake) has already started a refetch when the purge resolves. Cancelling that fetch would
    // revert the query to its pre-fetch snapshot and strand the OTHER lake under Deleted, so the
    // fetch is allowed to finish - the queryFn filter is what keeps the purged row hidden.
    let releaseInFlight = (_value: unknown) => {};
    const inFlight = new Promise(resolve => {
      releaseInFlight = resolve;
    });

    apiGet.mockResolvedValueOnce(listing('lk9', 'lk10')); // mount
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    // A refetch starts and hangs. Its eventual answer reflects lk10 having been restored elsewhere.
    apiGet.mockImplementationOnce(async () => {
      await inFlight;
      return listing('lk9');
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await waitFor(() => expect(deletedFetchCount()).toBe(2));

    // Purge lk9 while that fetch is still outstanding, then let it land.
    await act(async () => {
      await result.current.cleanup.mutateAsync('lk9');
    });
    await act(async () => {
      releaseInFlight(null);
      await settle();
    });

    // The in-flight answer was applied (lk10 is gone because it was restored), and lk9 stays hidden
    // even though that response still listed it.
    expect(result.current.deleted.data).toEqual([]);
  });

  it('does not prune on a response from a request that predates the purge', async () => {
    // The prune must only trust a request that STARTED after the purge. An older one can be missing
    // the lake for an unrelated reason (it predates the soft-delete), and pruning on it would
    // un-hide a row whose sweep has not run.
    let releaseStale = (_value: unknown) => {};
    const stale = new Promise(resolve => {
      releaseStale = resolve;
    });

    apiGet.mockResolvedValueOnce(listing('lk11', 'lk12')); // mount
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    // In-flight fetch that will answer WITHOUT lk11 - as if taken before lk11 was soft-deleted.
    apiGet.mockImplementationOnce(async () => {
      await stale;
      return listing('lk12');
    });
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ['data-lakes'] });
    });
    await waitFor(() => expect(deletedFetchCount()).toBe(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk11');
    });
    await act(async () => {
      releaseStale(null);
      await settle();
    });

    // lk11 must still be suppressed: a later fetch that DOES list it keeps the row hidden.
    apiGet.mockResolvedValue(listing('lk11', 'lk12'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    // Settle before asserting: waitFor would pass instantly against the pre-render snapshot, which
    // makes the assertion unfailable (it did, until this was caught).
    await settle();
    expect(deletedFetchCount()).toBe(3);
    expect(result.current.deleted.data).toEqual([deletedLake('lk12')]);
  });

  it('stops suppressing a purged id once the server no longer lists it', async () => {
    // Self-prune, so the set cannot grow forever or hide a lake indefinitely. Second phase asserts
    // the id was genuinely dropped rather than suppressed for the rest of the session.
    apiGet.mockResolvedValue(listing('lk7', 'lk8'));
    const { result, queryClient } = mountPurgeSurface();
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));

    await act(async () => {
      await result.current.cleanup.mutateAsync('lk7');
    });

    // Sweep finished: the endpoint stops listing lk7, which is what prunes it.
    apiGet.mockResolvedValue(listing('lk8'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    await waitFor(() => expect(result.current.deleted.data).toEqual([deletedLake('lk8')]));

    apiGet.mockResolvedValue(listing('lk7', 'lk8'));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['data-lakes', 'deleted'] });
    });
    await waitFor(() => expect(result.current.deleted.data).toHaveLength(2));
  });
});

describe('useDataLakeSpend isForbidden', () => {
  const mountSpend = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    return renderHook(() => useDataLakeSpend('lake1', 30), { wrapper });
  };

  const axiosError = (status: number) => {
    const err = new Error(`request failed with status ${status}`) as Error & {
      isAxiosError: boolean;
      response: { status: number };
    };
    err.isAxiosError = true;
    err.response = { status };
    return err;
  };

  beforeEach(() => {
    apiGet.mockReset();
  });

  it('treats a 403 as forbidden', async () => {
    apiGet.mockRejectedValue(axiosError(403));
    const { result } = mountSpend();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(true);
  });

  // A transient 500 must not be treated as forbidden: retry:false means the Spend tab would
  // otherwise stay hidden until the query is invalidated, even though nothing is actually denied.
  it('does not treat a 500 as forbidden', async () => {
    apiGet.mockRejectedValue(axiosError(500));
    const { result } = mountSpend();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(false);
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

/**
 * Rebuild badge poll cadence. This logic has now carried two consecutive defects - it stopped
 * polling before the work it reported on had finished, and then, once both counts were summed, it
 * could never stop at all - and both shipped because nothing executed it. nextRebuildPoll is pure
 * precisely so this file can.
 */
describe('nextRebuildPoll', () => {
  const start = INITIAL_REBUILD_POLL_STATE;

  it('backs off as the backlog grows', () => {
    expect(nextRebuildPoll(1, start).interval).toBe(5_000);
    expect(nextRebuildPoll(51, start).interval).toBe(15_000);
    expect(nextRebuildPoll(201, start).interval).toBe(30_000);
  });

  it('stops immediately when there was never a backlog to drain', () => {
    expect(nextRebuildPoll(0, start).interval).toBe(false);
  });

  it('TERMINATES after the backlog clears, even though a failed file keeps failedCount above zero', () => {
    // The regression this exists to catch: gating the loop on underChunkedCount + failedCount. A
    // permanently-failed file never retries on its own, so that sum is pinned above zero and the
    // panel polls a full lake rescan every 5s forever. The count alone must be the loop condition.
    let state = nextRebuildPoll(3, start).next; // a backlog was seen
    let polls = 0;
    let interval = nextRebuildPoll(0, state).interval;
    while (interval !== false) {
      polls += 1;
      expect(polls).toBeLessThan(100); // fails loudly rather than hanging if it never terminates
      state = nextRebuildPoll(0, state).next;
      interval = nextRebuildPoll(0, state).interval;
    }
    expect(polls).toBeGreaterThan(0); // but it did keep polling for a while first
  });

  it('keeps polling briefly after the backlog clears, so a late failure still lands', () => {
    // underChunkedCount drops when a wave is RESET, minutes before those chunk jobs finish.
    const state = nextRebuildPoll(3, start).next;
    expect(nextRebuildPoll(0, state).interval).not.toBe(false);
  });

  it('restarts the settle window when a new backlog appears', () => {
    let state = nextRebuildPoll(3, start).next;
    state = nextRebuildPoll(0, state).next; // one settle poll consumed
    expect(nextRebuildPoll(5, state).next.settlePolls).toBe(0);
  });
});

describe('useRechunkDataLake cache invalidation', () => {
  it('refreshes lake HEALTH too, not just the rebuild badge', async () => {
    // A rebuild mass-mutates the exact per-file rollups health is computed from. The health query has
    // no refetchInterval and refetchOnWindowFocus:false, and its observer stays mounted while the
    // panel re-renders, so staleTime alone never refreshes it. Without this invalidation the badge
    // sits frozen for the whole rebuild while the "to rebuild" chip ticks to zero beside it - which
    // reads as "the rebuild accomplished nothing". The other two lake mutations already do both.
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      React.createElement(QueryClientProvider, { client: queryClient }, children);
    apiPost.mockResolvedValueOnce({ data: { detected: 2, enqueued: 2, remaining: 0 } });

    const { result } = renderHook(() => useRechunkDataLake('lake1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(undefined);
    });

    const keys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(['dataLakeHealth', 'lake1']));
    expect(keys).toContain(JSON.stringify(['dataLakeRebuildStatus', 'lake1']));
    expect(keys).toContain(JSON.stringify(['dataLakeFiles', 'lake1']));
  });
});
